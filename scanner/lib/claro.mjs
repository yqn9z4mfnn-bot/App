import { claroGet, claroPost, claroDelete } from './http.mjs';
import { normalizeBrMobile } from './fetch-claro-link.mjs';
import { isTransientFetchError } from './transient-fetch.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createSession(jwt) {
  const maxRetries = Number(process.env.CLARO_API_429_RETRIES) || 4;
  const backoffMs = Number(process.env.CLARO_LINK_429_BACKOFF_MS) || 1500;

  let res = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      res = await claroPost(
        '/sessions/',
        null,
        {
          data: jwt,
          type: 'encrypted',
          channel: ['minhaclaro_web', 'MINHA_CLARO_WEB'],
          origin: 'login',
        },
        {
          logLabel: attempt === 1 && process.env.PROXY_LOG_IP ? 'POST /sessions/' : undefined,
          rotateIp: attempt > 1,
        },
      );
    } catch (err) {
      if (attempt < maxRetries && isTransientFetchError(err)) {
        console.warn(
          `[claro-api] POST /sessions/ rede — tentativa ${attempt}/${maxRetries}: ${err.message}`,
        );
        await sleep(backoffMs * attempt);
        continue;
      }
      throw err;
    }

    if (res.status !== 429) break;

    if (attempt < maxRetries) {
      console.warn(
        `[claro-api] POST /sessions/ 429 — tentativa ${attempt}/${maxRetries}, IP novo em ${backoffMs * attempt}ms`,
      );
      await sleep(backoffMs * attempt);
    }
  }

  if (res.status !== 200 && res.status !== 201) {
    const msg = typeof res.body === 'object' ? JSON.stringify(res.body) : res.body;
    throw new Error(`Falha no login (${res.status}): ${msg}`);
  }

  return res.body;
}

/** Endpoints essenciais — número, saldo, valores, cartões API, histórico. */
export async function scanClaroEssential(sessionId, msisdn, { includeProducts = true } = {}) {
  const base = `/customers/${msisdn}`;
  const jobs = [
    ['customer', claroGet(base, sessionId)],
    ['balance', claroGet(`${base}/recharge/balance`, sessionId)],
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

export async function fetchRechargeProducts(sessionId, msisdn) {
  return claroGet(`/customers/${msisdn}/products`, sessionId);
}

export async function fetchRechargeBalance(sessionId, msisdn) {
  return claroGet(`/customers/${msisdn}/recharge/balance`, sessionId);
}

export async function fetchRecharges(sessionId, msisdn) {
  return claroGet(`/customers/${msisdn}/recharges`, sessionId, {
    retries: 2,
    timeoutMs: 12_000,
  });
}

export async function createSmartCheckout(sessionId, msisdn, productId, opts = {}) {
  const recipient = normalizeBrMobile(opts.recipient ?? msisdn) ?? msisdn;
  const payer = normalizeBrMobile(opts.payerMsisdn ?? msisdn) ?? msisdn;
  const { logLabel, ...rest } = opts;
  return claroPost(
    `/customers/${msisdn}/smartcheckout/v2/url`,
    sessionId,
    {
      msisdn: payer,
      channel: 'MINHA_CLARO_WEB',
      recipient,
      productId,
    },
    { logLabel, ...rest },
  );
}

export async function deleteClaroPaymentMethod(sessionId, msisdn, cardToken, type = 'credit') {
  return claroDelete(
    `/customers/${msisdn}/payment-methods/${type}-${encodeURIComponent(cardToken)}`,
    sessionId,
  );
}
