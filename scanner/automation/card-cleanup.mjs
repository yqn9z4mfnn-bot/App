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

const codeFromUrl = (url) => pickCheckoutCode(String(url ?? '').match(/[?&]code=([^&]+)/i)?.[1]);

/** Atualiza contexto de checkout — persiste mesmo quando captures[] roda (limite 40). */
export const absorbCheckoutCtxFromCapture = (ctx, cap) => {
  if (!ctx || !cap) return ctx;
  const u = cap.url || '';
  const b = cap.body;
  const ok = cap.httpStatus >= 200 && cap.httpStatus < 300;

  const urlCode = codeFromUrl(u);
  if (urlCode) ctx.checkoutCode = urlCode;

  if (b && typeof b === 'object') {
    if (ok && /\/sessions\/?(?:\?|$)/i.test(u)) {
      ctx.claroSessionId = b.id || b.sessionId || ctx.claroSessionId;
    }
    if (ok && /smartcheckout\/v2\/url/i.test(u)) {
      ctx.checkoutCode = pickCheckoutCode(b.token, b.code, b.checkoutCode, ctx.checkoutCode);
      ctx.checkoutUrl = b.url || b.checkoutUrl || ctx.checkoutUrl;
    }
    if (ok && /bemobi\.com\/api\/v1\/session/i.test(u)) {
      ctx.bemobiToken = b.token || ctx.bemobiToken;
      ctx.checkoutCode = pickCheckoutCode(urlCode, ctx.checkoutCode);
    }
    if (ok && /tokenizer\/validation/i.test(u)) {
      ctx.cardToken = b.card_token || ctx.cardToken;
    }
    if (/api-bsc\/api\/v1\/payments/i.test(u) && !/\/sse/i.test(u)) {
      const tok = b?.card?.token || b?.payments?.[0]?.card?.token;
      if (tok) ctx.cardToken = tok;
    }
  }

  if (/eldorado\.m4u\.com\.br\/bsc\/checkout/i.test(u)) {
    ctx.checkoutUrl = ctx.checkoutUrl || u.split('?')[0] + (u.includes('?') ? '?' + u.split('?')[1] : '');
    ctx.checkoutCode = pickCheckoutCode(urlCode, ctx.checkoutCode);
  }

  return ctx;
};

export const createCheckoutCtx = () => ({
  checkoutCode: null,
  checkoutUrl: null,
  bemobiToken: null,
  cardToken: null,
  claroSessionId: null,
});

/** Extrai tokens/códigos das capturas HTTP + frames Eldorado + ctx persistido. */
export const extractCheckoutContext = (gateCapture, page) => {
  const ctx = { ...createCheckoutCtx(), ...(gateCapture?.checkoutCtx ?? {}) };
  const captures = gateCapture?.captures ?? [];

  for (const c of captures) {
    absorbCheckoutCtxFromCapture(ctx, c);
  }

  try {
    for (const frame of page?.frames?.() ?? []) {
      const fu = frame.url() || '';
      ctx.checkoutCode = pickCheckoutCode(fu.match(/[?&]code=([^&]+)/i)?.[1], ctx.checkoutCode);
      if (/eldorado\.m4u\.com\.br\/bsc\/checkout/i.test(fu)) {
        ctx.checkoutUrl = ctx.checkoutUrl || fu;
      }
    }
  } catch {
    // ignore
  }

  try {
    const pageUrl = page?.url?.() || '';
    ctx.checkoutCode = pickCheckoutCode(pageUrl.match(/[?&]code=([^&]+)/i)?.[1], ctx.checkoutCode);
  } catch {
    // ignore
  }

  return ctx;
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
    const urlForBemobi = ctx.checkoutUrl || 'https://smart-checkout.bemobi.com/';
    try {
      const bemobiRes = await fetchBemobiSession(urlForBemobi, ctx.checkoutCode);
      if (bemobiRes.status >= 200 && bemobiRes.status < 300) {
        ctx.bemobiToken = bemobiRes.body?.token || ctx.bemobiToken;
      } else {
        console.log(`[automation][card] bemobi session HTTP ${bemobiRes.status}`);
      }
    } catch (err) {
      console.log(
        `[automation][card] bemobi session falhou: ${String(err?.message || err).slice(0, 120)}`,
      );
    }
  }

  if (!ctx.checkoutCode) {
    console.log('[automation][card] checkoutCode ausente — não dá para DELETE na wallet Eldorado');
  } else if (!ctx.bemobiToken) {
    console.log('[automation][card] bemobiToken ausente após fetch — tentando DELETE mesmo assim');
  }

  try {
    const { ok, results } = await deleteCardEverywhere({
      bemobiToken: ctx.bemobiToken,
      checkoutCode: ctx.checkoutCode,
      sessionId: ctx.claroSessionId,
      msisdn: accessNumber,
      cardToken: ctx.cardToken,
    });
    const walletSt = results?.find((r) => r?.status != null && r.status !== 0)?.status ?? results?.[0]?.status;
    console.log(
      `[automation][card] removido *${ctx.cardToken.slice(-4)} ok=${ok} ` +
        `code=${ctx.checkoutCode ? 'sim' : 'nao'} bemobi=${Boolean(ctx.bemobiToken)} ` +
        `wallet=${walletSt ?? '?'} claro=${results?.[1]?.status ?? '—'}`,
    );
    return { ok, cardToken: ctx.cardToken, results };
  } catch (err) {
    console.log(`[automation][card] falha ao remover: ${String(err?.message || err).slice(0, 160)}`);
    return { ok: false, reason: 'delete_failed', error: String(err?.message || err) };
  }
};
