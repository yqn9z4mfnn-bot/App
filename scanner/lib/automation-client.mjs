import { cardToPam, centsToRechargeValue } from './card-to-pam.mjs';

const DEFAULT_URL = process.env.AUTOMATION_API_URL || 'http://127.0.0.1:3000';

async function automationFetch(path, body) {
  const url = `${DEFAULT_URL.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Automação HTTP ${res.status}`);
  }
  return data;
}

/**
 * Recarga via Playwright (Edge + JWT minhaclaro_web).
 * @param {object} opts
 */
export async function runBrowserRecharge({
  loginUrl,
  msisdn,
  productValue,
  card,
  browser = process.env.BROWSER_NAME || 'edge',
}) {
  const started = Date.now();
  const pamInfo = cardToPam(card);
  const rechargeValue = centsToRechargeValue(productValue);
  const pan = pamInfo.split('|')[0];

  const data = await automationFetch('/api/session/start-web-link', {
    loginUrl,
    accessNumber: msisdn,
    rechargeTargetNumber: msisdn,
    rechargeValue,
    pamInfo,
    browser,
  });

  const pr = data.paymentResult ?? {};
  const status = String(pr.status || data.status || 'UNKNOWN').toUpperCase();
  const mapped =
    status === 'SUCCESS' || pr.status === 'success'
      ? 'CONFIRMED'
      : status === 'TIMEOUT' || pr.status === 'timeout'
        ? 'TIMEOUT'
        : 'DENIED';

  return {
    paymentId: pr.gateCode ?? data.sessionId ?? null,
    pending: null,
    result: {
      status: mapped,
      message: pr.gateMessage || pr.message || data.lastError || null,
      negativeReason: pr.gateMessage || null,
    },
    valueCents: productValue,
    latencyMs: Date.now() - started,
    cardMask: `****${pan.slice(-4)}`,
    automation: {
      sessionId: data.sessionId,
      browser: data.browser,
      url: data.url,
      raw: pr,
    },
  };
}

export async function automationHealth() {
  const url = `${DEFAULT_URL.replace(/\/$/, '')}/health`;
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`health ${res.status}`);
  return res.json();
}

export function isBrowserRechargeEnabled() {
  return String(process.env.RECHARGE_MODE ?? 'browser').toLowerCase() !== 'api';
}
