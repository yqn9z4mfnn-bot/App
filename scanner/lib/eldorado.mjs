import { request } from './http.mjs';
import { createSmartCheckout, deleteClaroPaymentMethod } from './claro.mjs';

function bemobiSessionBase(checkoutUrl) {
  if (checkoutUrl.includes('smart-checkout-dev.bemobi.com')) {
    return 'https://smart-checkout-dev.bemobi.com';
  }
  return 'https://smart-checkout.bemobi.com';
}

export async function fetchBemobiSession(checkoutUrl, checkoutCode) {
  const base = bemobiSessionBase(checkoutUrl);
  return request(`${base}/api/v1/session?code=${checkoutCode}`, {
    headers: { accept: 'application/json' },
  });
}

export async function fetchWalletCards(bemobiToken, checkoutCode) {
  return request(
    'https://eldorado.m4u.com.br/api-bsc/api/v1/cards?all_tokens=true',
    {
      headers: {
        authorization: `Bearer ${bemobiToken}`,
        'x-bsc': 'client',
        'x-session-id': checkoutCode,
        accept: 'application/json',
      },
    },
  );
}

export async function openWalletSession(sessionId, msisdn, productId) {
  const checkoutRes = await createSmartCheckout(sessionId, msisdn, productId);

  if (checkoutRes.status === 429) {
    return {
      error: 'rate_limited',
      message: 'POST /smartcheckout/v2/url retornou 429 — aguarde alguns minutos',
      checkout: checkoutRes,
    };
  }

  if (checkoutRes.status !== 201 && checkoutRes.status !== 200) {
    return {
      error: 'checkout_failed',
      message: `Smart checkout falhou (${checkoutRes.status})`,
      checkout: checkoutRes,
    };
  }

  const { token: checkoutCode, url: checkoutUrl } = checkoutRes.body;
  const bemobiRes = await fetchBemobiSession(checkoutUrl, checkoutCode);

  if (bemobiRes.status !== 200 && bemobiRes.status !== 201) {
    return {
      error: 'bemobi_session_failed',
      checkout: checkoutRes,
      bemobi: bemobiRes,
    };
  }

  const bemobiToken = bemobiRes.body?.token;
  return {
    checkout: checkoutRes,
    bemobi: bemobiRes,
    checkoutCode,
    checkoutUrl,
    bemobiToken,
  };
}

export async function deleteWalletCard(bemobiToken, checkoutCode, cardToken) {
  return request(
    `https://eldorado.m4u.com.br/api-bsc/api/v1/cards/${encodeURIComponent(cardToken)}?all_tokens=true`,
    {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${bemobiToken}`,
        'x-bsc': 'client',
        'x-session-id': checkoutCode,
        accept: 'application/json',
      },
    },
  );
}

/** Remove todos os cartões da wallet Eldorado (DELETE paralelo com ?all_tokens=true). */
export async function deleteAllWalletCards(bemobiToken, checkoutCode, cards) {
  const list = Array.isArray(cards) ? cards.filter((c) => c?.token) : [];
  if (!list.length) return { ok: 0, total: 0, results: [] };
  const results = await Promise.all(
    list.map((c) => deleteWalletCard(bemobiToken, checkoutCode, c.token)),
  );
  const ok = results.filter((r) => r.status === 200 || r.status === 204).length;
  return { ok, total: list.length, results };
}

/** Remove na wallet Eldorado e na API Claro (/payment-methods). */
export async function deleteCardEverywhere({
  bemobiToken,
  checkoutCode,
  sessionId,
  msisdn,
  cardToken,
}) {
  const jobs = [];
  if (bemobiToken && checkoutCode) {
    jobs.push(deleteWalletCard(bemobiToken, checkoutCode, cardToken));
  }
  if (sessionId && msisdn) {
    jobs.push(deleteClaroPaymentMethod(sessionId, msisdn, cardToken));
  }
  const results = await Promise.all(
    jobs.map((p) => p.catch((err) => ({ status: 0, error: err.message }))),
  );
  const ok = results.some((r) => r.status === 200 || r.status === 204);
  return { ok, results };
}

export function unifySavedCards(walletBody, paymentMethodsBody) {
  const byToken = new Map();
  const wallet = Array.isArray(walletBody) ? walletBody : [];
  for (const c of wallet) {
    if (!c?.token) continue;
    byToken.set(c.token, {
      ...c,
      last: c.last ?? c.lastDigits,
      source: 'wallet',
    });
  }
  const methods = Array.isArray(paymentMethodsBody) ? paymentMethodsBody : [];
  const claroEls = methods.find((m) => m.type === 'credit')?.elements ?? [];
  for (const c of claroEls) {
    if (!c?.token) continue;
    const existing = byToken.get(c.token);
    if (existing) {
      existing.last = existing.last ?? c.lastDigits;
      existing.source = 'both';
    } else {
      byToken.set(c.token, {
        token: c.token,
        brand: c.brand,
        bin: c.bin,
        last: c.lastDigits ?? c.last,
        expirationMonth: c.expirationMonth,
        expirationYear: c.expirationYear,
        source: 'claro',
      });
    }
  }
  return [...byToken.values()];
}

export async function scanWallet(sessionId, msisdn, productId) {
  const session = await openWalletSession(sessionId, msisdn, productId);
  if (session.error) {
    return {
      error: session.error,
      message: session.message,
      checkout: session.checkout,
      walletCards: null,
    };
  }

  const { bemobiToken, checkoutCode, checkout, bemobi } = session;
  const cardsRes = await fetchWalletCards(bemobiToken, checkoutCode);

  return {
    checkout,
    bemobi,
    walletCards: cardsRes,
    checkoutCode,
    bemobiToken,
  };
}
