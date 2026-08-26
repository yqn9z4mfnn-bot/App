import { claroGet, claroPost } from './http.mjs';

export async function createSession(jwt) {
  const res = await claroPost('/sessions/', null, {
    data: jwt,
    type: 'encrypted',
    channel: ['minhaclaro_web', 'MINHA_CLARO_WEB'],
    origin: 'login',
  });

  if (res.status !== 200 && res.status !== 201) {
    const msg = typeof res.body === 'object' ? JSON.stringify(res.body) : res.body;
    throw new Error(`Falha no login (${res.status}): ${msg}`);
  }

  return res.body;
}

/** Endpoints essenciais — número, valores, cartões API, histórico (~6 req). */
export async function scanClaroEssential(sessionId, msisdn, { includeProducts = true } = {}) {
  const base = `/customers/${msisdn}`;
  const jobs = [
    ['customer', claroGet(base, sessionId)],
    ...(includeProducts ? [['products', claroGet(`${base}/products`, sessionId)]] : []),
    ['paymentMethods', claroGet(`${base}/payment-methods`, sessionId)],
    ['recharges', claroGet(`${base}/recharges`, sessionId)],
    ['rechargesRecurring', claroGet(`${base}/recharges?reloadType=recurring`, sessionId)],
    ['scheduledRecharges', claroGet(`${base}/scheduled-recharges`, sessionId)],
  ];

  const entries = await Promise.all(
    jobs.map(async ([key, promise]) => [key, await promise]),
  );
  return Object.fromEntries(entries);
}

export async function scanClaroApi(sessionId, msisdn) {
  const base = `/customers/${msisdn}`;
  const featureFlags = [
    'maintenance',
    'loginWithValue',
    'environmentCheckout',
    'fraud_analysis',
    'OTPModal',
    'upsell_recharge',
    'recharge_for_others',
    'value_page_without_banner',
    'value_page_without_bonus',
    'channel_without_footer',
    'value_card_with_no_expiration_date',
    'url_without_channel',
  ];

  const jobs = [
    ['customer', claroGet(base, sessionId)],
    ['products', claroGet(`${base}/products`, sessionId)],
    ['paymentMethods', claroGet(`${base}/payment-methods`, sessionId)],
    ['recharges', claroGet(`${base}/recharges`, sessionId)],
    ['rechargesRecurring', claroGet(`${base}/recharges?reloadType=recurring`, sessionId)],
    ['recipients', claroGet(`${base}/recipients`, sessionId)],
    ['scheduledRecharges', claroGet(`${base}/scheduled-recharges`, sessionId)],
    ['balance', claroGet(`${base}/recharge/balance`, sessionId)],
    ['govisa', claroGet(`/govisa/${msisdn}`, sessionId)],
    ['govisaActivated', claroGet(`/govisa/${msisdn}/activated`, sessionId)],
    ['banners', claroGet('/banners', sessionId)],
    ['featuresPublic', claroGet('/v1/features/public', sessionId)],
    [
      'featuresSmartcheckout',
      claroGet('/v1/features/group/smartcheckout/enabled', sessionId),
    ],
    ...featureFlags.map((name) => [
      `feature_${name}`,
      claroGet(`/v1/features/${name}/enabled`, sessionId),
    ]),
  ];

  const entries = await Promise.all(
    jobs.map(async ([key, promise]) => {
      const result = await promise;
      return [key, result];
    }),
  );

  return Object.fromEntries(entries);
}

export async function createSmartCheckout(sessionId, msisdn, productId) {
  return claroPost(`/customers/${msisdn}/smartcheckout/v2/url`, sessionId, {
    msisdn,
    channel: 'MINHA_CLARO_WEB',
    recipient: msisdn,
    productId,
  });
}
