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
  targetMsisdn = null,
  productValue,
  card,
  browser = process.env.BROWSER_NAME || 'edge',
}) {
  const started = Date.now();
  const pamInfo = cardToPam(card);
  const rechargeValue = centsToRechargeValue(productValue);
  const pan = pamInfo.split('|')[0];
  const accessNumber = String(msisdn ?? '').replace(/\D/g, '');
  const rechargeTargetNumber = String(targetMsisdn ?? msisdn ?? '').replace(/\D/g, '');

  const data = await automationFetch('/api/session/start-web-link', {
    loginUrl,
    accessNumber,
    rechargeTargetNumber,
    rechargeValue,
    pamInfo,
    browser,
  });

  const pr = data.paymentResult ?? {};
  const rawStatus = String(pr.status || data.status || 'UNKNOWN').toLowerCase();
  const mapped =
    rawStatus === 'success'
      ? 'CONFIRMED'
      : rawStatus === '3ds_required'
        ? '3DS_REQUIRED'
        : rawStatus === 'timeout'
          ? 'TIMEOUT'
          : rawStatus === 'error'
            ? 'DENIED'
            : 'PENDING';

  const debugReport = pr.debug ?? null;
  const threeDsHint = pr.threeDs?.hint ? String(pr.threeDs.hint).slice(0, 120) : null;
  const debugHint = debugReport?.pageUrl
    ? `URL final: ${debugReport.pageUrl}`
    : pr.url
      ? `URL: ${pr.url}`
      : null;

  const baseMessage = pr.gateMessage || pr.message || data.lastError || null;
  const messageParts = [baseMessage, threeDsHint, debugHint].filter(Boolean);

  return {
    paymentId: pr.gateCode ?? data.sessionId ?? null,
    pending: null,
    result: {
      status: mapped,
      message: messageParts.join(' · ') || null,
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
      debugJson: debugReport?.jsonPath ?? pr.debug?.jsonPath ?? null,
      gateCaptureCount: debugReport?.gateCaptureCount ?? null,
      lastGateStatus: debugReport?.gateCaptures?.slice(-1)?.[0]?.status ?? null,
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

/** HTTP prepara checkout Eldorado → Edge só preenche cartão e paga. */
export async function runHybridRecharge({
  loginUrl,
  msisdn,
  targetMsisdn = null,
  productValue,
  card,
  browser = process.env.BROWSER_NAME || 'edge',
}) {
  if (targetMsisdn && normalizeTarget(targetMsisdn) !== normalizeTarget(msisdn)) {
    throw new Error('Recarga cruzada ainda não suportada no modo híbrido.');
  }
  const started = Date.now();
  const pamInfo = cardToPam(card);
  const rechargeValue = centsToRechargeValue(productValue);
  const accessNumber = String(msisdn ?? '').replace(/\D/g, '');

  const data = await automationFetch('/api/session/start-checkout-link', {
    loginUrl,
    accessNumber,
    rechargeValue,
    pamInfo,
    browser,
  });

  const pr = data.paymentResult ?? {};
  const rawStatus = String(pr.status || data.status || 'UNKNOWN').toLowerCase();
  const mapped =
    rawStatus === 'success'
      ? 'CONFIRMED'
      : rawStatus === '3ds_required'
        ? '3DS_REQUIRED'
        : rawStatus === 'timeout'
          ? 'TIMEOUT'
          : rawStatus === 'error'
            ? 'DENIED'
            : 'PENDING';

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
    cardMask: `****${pamInfo.split('|')[0].slice(-4)}`,
    automation: {
      sessionId: data.sessionId,
      mode: data.mode ?? 'checkout-link',
      httpPrepMs: data.httpPrep?.httpLatencyMs ?? null,
      raw: pr,
    },
  };
}

function normalizeTarget(n) {
  return String(n ?? '').replace(/\D/g, '');
}
