import { cardToPam, centsToRechargeValue } from './card-to-pam.mjs';
import { isVisualVbv } from '../automation/threeds.mjs';
import {
  isAutomationFailureMessage,
  isGateDenialMessage,
  paymentBodyIsDenied,
} from './card-outcome.mjs';
import { looksLikeCheckoutError, looksLikeCheckoutSuccess } from './checkout-error.mjs';
import { formatCardMask } from './card-parse.mjs';

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
  const mapped = mapAutomationPaymentStatus(pr, data);

  const threeDs = pr.threeDs ?? null;
  const visualVbv = Boolean(pr.visualVbv ?? (threeDs && isVisualVbv(threeDs)));

  const debugReport = pr.debug ?? null;
  const threeDsHint = threeDs?.hint ? String(threeDs.hint).slice(0, 120) : null;
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
      gateCode: pr.gateCode ?? null,
      visualVbv,
      threeDsKind: threeDs?.kind ?? null,
      threeDsHint,
    },
    valueCents: productValue,
    latencyMs: Date.now() - started,
    cardMask: formatCardMask(pan),
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Aguarda nenhuma sessão Edge ativa antes de abrir nova tentativa (auto-retry). */
export async function waitForAutomationIdle({ timeoutMs = 15000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = await automationHealth();
      if ((health.aliveSessions ?? 0) <= 0) return true;
    } catch {
      return false;
    }
    await sleep(pollMs);
  }
  console.log('[automation-client] waitForAutomationIdle: timeout com sessões ainda abertas');
  return false;
}

export function isBrowserRechargeEnabled() {
  return String(process.env.RECHARGE_MODE ?? 'browser').toLowerCase() !== 'api';
}

/** HTTP prepara checkout → Edge só paga (padrão quando RECHARGE_BROWSER_FLOW=checkout-link). */
export function isHybridRechargeEnabled() {
  return (
    isBrowserRechargeEnabled() &&
    String(process.env.RECHARGE_BROWSER_FLOW ?? 'checkout-link').toLowerCase() !== 'weblink'
  );
}

/** HTTP prepara checkout Eldorado → Edge só preenche cartão e paga. */
export async function runHybridRecharge({
  loginUrl,
  msisdn,
  targetMsisdn = null,
  productValue,
  card,
  browser = process.env.BROWSER_NAME || 'edge',
  claroSessionId = null,
}) {
  if (targetMsisdn && normalizeTarget(targetMsisdn) !== normalizeTarget(msisdn)) {
    // recarga cruzada suportada no checkout-link
  }
  const started = Date.now();
  const pamInfo = cardToPam(card);
  const rechargeValue = centsToRechargeValue(productValue);
  const accessNumber = String(msisdn ?? '').replace(/\D/g, '');
  const rechargeTargetNumber = String(targetMsisdn ?? msisdn ?? '').replace(/\D/g, '');

  const data = await automationFetch('/api/session/start-checkout-link', {
    loginUrl,
    accessNumber,
    rechargeTargetNumber,
    rechargeValue,
    pamInfo,
    browser,
    claroSessionId: claroSessionId || undefined,
  });

  const pr = data.paymentResult ?? {};
  const mapped = mapAutomationPaymentStatus(pr, data);

  const threeDs = pr.threeDs ?? null;
  const visualVbv = Boolean(pr.visualVbv ?? (threeDs && isVisualVbv(threeDs)));

  return {
    paymentId: pr.gateCode ?? data.sessionId ?? null,
    pending: null,
    result: {
      status: mapped,
      message: pr.gateMessage || pr.message || data.lastError || null,
      negativeReason: pr.gateMessage || null,
      gateCode: pr.gateCode ?? null,
      visualVbv,
      threeDsKind: threeDs?.kind ?? null,
      threeDsHint: threeDs?.hint ? String(threeDs.hint).slice(0, 120) : null,
    },
    valueCents: productValue,
    latencyMs: Date.now() - started,
    cardMask: formatCardMask(pamInfo.split('|')[0]),
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

export function mapAutomationPaymentStatus(pr, data = {}) {
  const rawStatus = String(pr.status || data.status || 'UNKNOWN').toLowerCase();
  const msg = String(pr.gateMessage || pr.message || data.lastError || '');
  const threeDsHint = String(pr.threeDs?.hint || '');
  const gateCode = String(pr.gateCode ?? '').toUpperCase();
  const pageUrl = pr.url || data.url || pr.debug?.pageUrl || '';

  if (rawStatus === 'success') return 'CONFIRMED';
  if (looksLikeCheckoutSuccess({ url: pageUrl, message: `${msg} ${threeDsHint}` })) {
    return 'CONFIRMED';
  }
  if (
    rawStatus !== 'success' &&
    looksLikeCheckoutError({ url: pageUrl, message: `${msg} ${threeDsHint}` })
  ) {
    return 'DENIED';
  }
  if (rawStatus === '3ds_required') return '3DS_REQUIRED';
  if (rawStatus === 'timeout') return 'TIMEOUT';

  if (rawStatus === 'error' || rawStatus === 'error_manual') {
    if (isAutomationFailureMessage(msg)) return 'AUTOMATION_FAIL';
    if (gateCode === 'DENIED' || paymentBodyIsDenied(pr.gateResponse?.body)) return 'DENIED';
    if (isGateDenialMessage(msg)) return 'DENIED';
    return 'AUTOMATION_FAIL';
  }

  return 'PENDING';
}
