import { config } from './config.mjs';
import { deleteCardEverywhere, fetchBemobiSession } from '../lib/eldorado.mjs';

const CHECKOUT_CODE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const pickCheckoutCode = (...candidates) => {
  for (const raw of candidates) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    const m = s.match(CHECKOUT_CODE_RE);
    if (m) return m[0];
  }
  return null;
};

/** Extrai tokens/códigos das capturas HTTP + frames Eldorado. */
export const extractCheckoutContext = (gateCapture, page) => {
  const captures = gateCapture?.captures ?? [];
  let checkoutCode = null;
  let checkoutUrl = null;
  let bemobiToken = null;
  let cardToken = null;
  let claroSessionId = null;

  for (const c of captures) {
    const u = c.url || '';
    const b = c.body;
    if (!b || typeof b !== 'object') continue;

    if (/\/sessions\/?(?:\?|$)/i.test(u) && c.httpStatus >= 200 && c.httpStatus < 300) {
      claroSessionId = b.id || b.sessionId || claroSessionId;
    }

    if (/smartcheckout\/v2\/url/i.test(u) && c.httpStatus >= 200 && c.httpStatus < 300) {
      checkoutCode = pickCheckoutCode(b.token, b.code, b.checkoutCode, checkoutCode);
      checkoutUrl = b.url || b.checkoutUrl || checkoutUrl;
    }

    if (/bemobi\.com\/api\/v1\/session/i.test(u) && c.httpStatus >= 200 && c.httpStatus < 300) {
      bemobiToken = b.token || bemobiToken;
    }

    if (/tokenizer\/validation/i.test(u) && c.httpStatus >= 200 && c.httpStatus < 300) {
      cardToken = b.card_token || cardToken;
    }

    if (/api-bsc\/api\/v1\/payments/i.test(u)) {
      const tok = b?.card?.token || b?.payments?.[0]?.card?.token;
      if (tok) cardToken = tok;
    }
  }

  try {
    for (const frame of page?.frames?.() ?? []) {
      const fu = frame.url() || '';
      checkoutCode = pickCheckoutCode(fu.match(/[?&]code=([^&]+)/i)?.[1], checkoutCode);
      if (/eldorado\.m4u\.com\.br\/bsc\/checkout/i.test(fu) && !checkoutUrl) {
        checkoutUrl = fu;
      }
    }
  } catch {
    // ignore
  }

  try {
    const pageUrl = page?.url?.() || '';
    checkoutCode = pickCheckoutCode(pageUrl.match(/[?&]code=([^&]+)/i)?.[1], checkoutCode);
  } catch {
    // ignore
  }

  return { checkoutCode, checkoutUrl, bemobiToken, cardToken, claroSessionId };
};

/** Remove cartão tokenizado na wallet Eldorado (e Claro se possível) após a recarga. */
export const removeUsedCardAfterRecharge = async (session, _paymentResult = null) => {
  if (!config.removeCardAfterRecharge) {
    return { skipped: true, reason: 'disabled' };
  }

  const { page, gateCapture, accessNumber } = session ?? {};
  const ctx = extractCheckoutContext(gateCapture, page);

  if (!ctx.cardToken) {
    console.log('[automation][card] card_token não capturado — cartão não removido');
    return { ok: false, reason: 'no_card_token' };
  }

  if (!ctx.bemobiToken && ctx.checkoutCode) {
    const urlForBemobi =
      ctx.checkoutUrl ||
      (config.bemobiCheckoutBase || 'https://smart-checkout.bemobi.com/');
    try {
      const bemobiRes = await fetchBemobiSession(urlForBemobi, ctx.checkoutCode);
      if (bemobiRes.status >= 200 && bemobiRes.status < 300) {
        ctx.bemobiToken = bemobiRes.body?.token || ctx.bemobiToken;
      }
    } catch (err) {
      console.log(
        `[automation][card] bemobi session falhou: ${String(err?.message || err).slice(0, 120)}`,
      );
    }
  }

  if (!ctx.bemobiToken || !ctx.checkoutCode) {
    console.log(
      `[automation][card] wallet incompleta (bemobi=${Boolean(ctx.bemobiToken)} code=${Boolean(ctx.checkoutCode)}) — tentando Claro`,
    );
  }

  try {
    const { ok, results } = await deleteCardEverywhere({
      bemobiToken: ctx.bemobiToken,
      checkoutCode: ctx.checkoutCode,
      sessionId: ctx.claroSessionId,
      msisdn: accessNumber,
      cardToken: ctx.cardToken,
    });
    console.log(
      `[automation][card] removido *${ctx.cardToken.slice(-4)} ok=${ok} ` +
        `wallet=${results?.[0]?.status ?? '?'} claro=${results?.[1]?.status ?? '—'}`,
    );
    return { ok, cardToken: ctx.cardToken, results };
  } catch (err) {
    console.log(`[automation][card] falha ao remover: ${String(err?.message || err).slice(0, 160)}`);
    return { ok: false, reason: 'delete_failed', error: String(err?.message || err) };
  }
};
