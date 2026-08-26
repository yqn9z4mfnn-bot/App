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

export async function scanWallet(sessionId, msisdn, productId) {
  const { createSmartCheckout } = await import('./claro.mjs');
  const checkoutRes = await createSmartCheckout(sessionId, msisdn, productId);

  if (checkoutRes.status === 429) {
    return {
      error: 'rate_limited',
      message: 'POST /smartcheckout/v2/url retornou 429 — aguarde ou reutilize um checkout_code',
      checkout: checkoutRes,
      walletCards: null,
    };
  }

  if (checkoutRes.status !== 201 && checkoutRes.status !== 200) {
    return {
      error: 'checkout_failed',
      message: `Smart checkout falhou (${checkoutRes.status})`,
      checkout: checkoutRes,
      walletCards: null,
    };
  }

  const { token: checkoutCode, url: checkoutUrl } = checkoutRes.body;
  const bemobiRes = await fetchBemobiSession(checkoutUrl, checkoutCode);

  if (bemobiRes.status !== 200 && bemobiRes.status !== 201) {
    return {
      error: 'bemobi_session_failed',
      checkout: checkoutRes,
      bemobi: bemobiRes,
      walletCards: null,
    };
  }

  const bemobiToken = bemobiRes.body?.token;
  const cardsRes = await fetchWalletCards(bemobiToken, checkoutCode);

  return {
    checkout: checkoutRes,
    bemobi: bemobiRes,
    walletCards: cardsRes,
    checkoutCode,
    bemobiToken: bemobiToken ? `${bemobiToken.slice(0, 8)}…` : null,
  };
}
