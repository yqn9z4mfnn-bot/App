import { config } from './config.mjs';
import {
  deleteCardEverywhere,
  deleteAllWalletCards,
  fetchBemobiSession,
  fetchWalletCards,
  openWalletSession,
  unifySavedCards,
} from '../lib/eldorado.mjs';
import { scanClaroEssential } from '../lib/claro.mjs';

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

const mergeHttpPrepContext = (ctx, session) => {
  const prep = session?.httpPrep;
  if (!prep) return ctx;
  ctx.claroSessionId = ctx.claroSessionId || prep.claroSessionId || null;
  ctx.checkoutCode = ctx.checkoutCode || prep.checkoutCode || null;
  ctx.checkoutUrl = ctx.checkoutUrl || prep.checkoutUrl || null;
  ctx.bemobiToken = ctx.bemobiToken || prep.bemobiToken || null;
  return ctx;
};

const refreshWalletCredentials = async (session, ctx) => {
  const prep = session?.httpPrep;
  if (!prep?.claroSessionId || !prep?.product?.id) return ctx;

  const accessNumber = session.accessNumber;
  const targetNumber = session.rechargeTargetNumber || accessNumber;
  try {
    const wallet = await openWalletSession(prep.claroSessionId, accessNumber, prep.product.id, {
      payerMsisdn: accessNumber,
      recipient: targetNumber,
    });
    if (wallet.error) {
      console.log(
        `[automation][card] wallet refresh: ${String(wallet.message || wallet.error).slice(0, 100)}`,
      );
      return ctx;
    }
    ctx.bemobiToken = wallet.bemobiToken || ctx.bemobiToken;
    ctx.checkoutCode = wallet.checkoutCode || ctx.checkoutCode;
    ctx.checkoutUrl = wallet.checkoutUrl || ctx.checkoutUrl;
  } catch (err) {
    console.log(`[automation][card] wallet refresh falhou: ${String(err?.message || err).slice(0, 100)}`);
  }
  return ctx;
};

const ensureBemobiToken = async (ctx) => {
  if (ctx.bemobiToken || !ctx.checkoutCode) return ctx;
  const urlForBemobi = ctx.checkoutUrl || 'https://smart-checkout.bemobi.com/';
  try {
    const bemobiRes = await fetchBemobiSession(urlForBemobi, ctx.checkoutCode);
    if (bemobiRes.status >= 200 && bemobiRes.status < 300) {
      ctx.bemobiToken = bemobiRes.body?.token || ctx.bemobiToken;
    } else {
      console.log(`[automation][card] bemobi session HTTP ${bemobiRes.status}`);
    }
  } catch (err) {
    console.log(`[automation][card] bemobi session falhou: ${String(err?.message || err).slice(0, 120)}`);
  }
  return ctx;
};

const purgeWalletCards = async (ctx) => {
  if (!ctx.bemobiToken || !ctx.checkoutCode) {
    return { ok: false, removed: 0, reason: 'no_wallet_credentials' };
  }
  const cardsRes = await fetchWalletCards(ctx.bemobiToken, ctx.checkoutCode);
  const cards = Array.isArray(cardsRes.body) ? cardsRes.body : [];
  if (!cards.length) return { ok: true, removed: 0, reason: 'wallet_empty' };

  const { ok, total } = await deleteAllWalletCards(ctx.bemobiToken, ctx.checkoutCode, cards);
  return { ok: ok > 0, removed: ok, total };
};

const purgeClaroCards = async (ctx, msisdns, cardToken = null) => {
  if (!ctx.claroSessionId) return { ok: false, removed: 0, reason: 'no_claro_session' };

  const targets = [...new Set(msisdns.filter(Boolean))];
  let removed = 0;
  const tokens = new Set(cardToken ? [cardToken] : []);

  for (const msisdn of targets) {
    try {
      const scan = await scanClaroEssential(ctx.claroSessionId, msisdn, { includeProducts: false });
      const saved = unifySavedCards([], scan.paymentMethods?.body);
      for (const card of saved) {
        if (card?.token) tokens.add(card.token);
      }
    } catch (err) {
      console.log(`[automation][card] scan claro ${msisdn}: ${String(err?.message || err).slice(0, 80)}`);
    }
  }

  if (!tokens.size) return { ok: true, removed: 0, reason: 'claro_empty' };

  const results = [];
  for (const msisdn of targets) {
    for (const token of tokens) {
      try {
        const res = await deleteCardEverywhere({
          bemobiToken: ctx.bemobiToken,
          checkoutCode: ctx.checkoutCode,
          sessionId: ctx.claroSessionId,
          msisdn,
          cardToken: token,
        });
        results.push(res);
        if (res.ok) removed += 1;
      } catch {
        // próximo
      }
    }
  }
  return { ok: removed > 0, removed, results };
};

/** Remove cartão tokenizado na wallet Eldorado (e Claro se possível) após a recarga. */
export const removeUsedCardAfterRecharge = async (session, _paymentResult = null) => {
  if (!config.removeCardAfterRecharge) {
    return { skipped: true, reason: 'disabled' };
  }

  const { page, gateCapture, accessNumber, rechargeTargetNumber } = session ?? {};
  let ctx = extractCheckoutContext(gateCapture, page);
  ctx = mergeHttpPrepContext(ctx, session);
  ctx = await ensureBemobiToken(ctx);

  const msisdns = [accessNumber, rechargeTargetNumber].filter(Boolean);

  if (ctx.cardToken && ctx.bemobiToken && ctx.checkoutCode) {
    try {
      const { ok, results } = await deleteCardEverywhere({
        bemobiToken: ctx.bemobiToken,
        checkoutCode: ctx.checkoutCode,
        sessionId: ctx.claroSessionId,
        msisdn: accessNumber,
        cardToken: ctx.cardToken,
      });
      const walletSt =
        results?.find((r) => r?.status != null && r.status !== 0)?.status ?? results?.[0]?.status;
      console.log(
        `[automation][card] token *${ctx.cardToken.slice(-4)} ok=${ok} wallet=${walletSt ?? '?'} ` +
          `claro=${results?.[1]?.status ?? '—'}`,
      );
    } catch (err) {
      console.log(`[automation][card] delete token falhou: ${String(err?.message || err).slice(0, 120)}`);
    }
  } else if (!ctx.cardToken) {
    console.log('[automation][card] card_token não capturado — purge completo da wallet');
  }

  ctx = await refreshWalletCredentials(session, ctx);
  ctx = await ensureBemobiToken(ctx);

  const walletPurge = await purgeWalletCards(ctx).catch((err) => ({
    ok: false,
    reason: String(err?.message || err),
  }));
  const claroPurge = await purgeClaroCards(ctx, msisdns, ctx.cardToken).catch((err) => ({
    ok: false,
    reason: String(err?.message || err),
  }));

  const ok = Boolean(walletPurge.ok || claroPurge.ok || ctx.cardToken);
  console.log(
    `[automation][card] pós-recarga wallet=${walletPurge.removed ?? 0}/${walletPurge.total ?? 0} ` +
      `claro=${claroPurge.removed ?? 0} ok=${ok}`,
  );

  if (walletPurge.removed > 0 || (walletPurge.reason === 'wallet_empty' && claroPurge.removed >= 0)) {
    return { ok: true, walletPurge, claroPurge, cardToken: ctx.cardToken ?? null };
  }
  if (!ctx.cardToken && walletPurge.reason === 'no_wallet_credentials' && !claroPurge.removed) {
    return { ok: false, reason: 'no_credentials', walletPurge, claroPurge };
  }
  return { ok, walletPurge, claroPurge, cardToken: ctx.cardToken ?? null };
};
