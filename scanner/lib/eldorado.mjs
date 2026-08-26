import { request } from './http.mjs';

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
  const { createSmartCheckout } = await import('./claro.mjs');
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

export async function fetchWalletCardsWithAuth(auth) {
  return fetchWalletCards(auth.bemobiToken, auth.checkoutCode);
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

export async function deleteAllWalletCards(bemobiToken, checkoutCode, cards) {
  const results = await Promise.all(
    cards.map((c) => deleteWalletCard(bemobiToken, checkoutCode, c.token)),
  );
  const ok = results.filter((r) => r.status === 200 || r.status === 204).length;
  return { ok, total: cards.length, results };
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
