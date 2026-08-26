import { startWebLinkRecharge } from './automation-client.mjs';
import { cardToPamInfo, rechargeValueFromCents } from './card-to-pam.mjs';

function maskFromPam(pamInfo) {
  const pan = String(pamInfo).split('|')[0]?.replace(/\D/g, '') ?? '';
  return pan.length >= 4 ? `****${pan.slice(-4)}` : '****';
}

function mapAutomationStatus(data) {
  const gate = data?.paymentResult ?? data;
  const st = String(gate?.status ?? data?.status ?? '').toLowerCase();

  if (st === 'success' || st === 'done') {
    return {
      status: 'SUCCESS',
      message: gate?.gateMessage || gate?.message || 'Pagamento confirmado',
      negativeReason: null,
    };
  }

  if (st === 'error' || st === 'error_manual' || st === 'timeout' || data?.gateCode) {
    return {
      status: st === 'timeout' ? 'TIMEOUT' : 'DENIED',
      message: data?.error || gate?.gateMessage || gate?.message || 'Pagamento recusado',
      negativeReason: data?.gateMessage || gate?.gateMessage || data?.claroErrorCode || null,
    };
  }

  if (data?.claroErrorCode === 'rate_limit') {
    return {
      status: 'RATE_LIMIT',
      message:
        data?.error ||
        data?.message ||
        'Muitas tentativas na Claro (429). Aguarde 15–30 minutos e tente novamente.',
      negativeReason: 'Rate limit Claro (429)',
    };
  }

  if (data?.claroErrorCode === 'checkout_api_error') {
    return {
      status: 'CHECKOUT_ERROR',
      message: data?.error || data?.message || 'Checkout indisponível — tente novamente em alguns minutos.',
      negativeReason: 'Checkout API error',
    };
  }

  if (data?.claroErrorCode === 'checkout_timeout') {
    return {
      status: 'TIMEOUT',
      message: data?.error || data?.message || 'Checkout não abriu a tempo (8s).',
      negativeReason: 'Checkout timeout',
    };
  }

  return {
    status: 'UNKNOWN',
    message: data?.message || data?.stepLabel || st || 'Resultado desconhecido',
    negativeReason: null,
  };
}

/**
 * Recarga pelo navegador (Playwright) — evita suspected fraud da API direta.
 * Requer server.js + automation.js rodando (AUTOMATION_API_URL).
 */
export async function runBrowserRecharge({
  apiUrl,
  loginUrl,
  msisdn,
  productValue,
  card,
  browser,
  startedAt = Date.now(),
}) {
  if (card.token) {
    throw new Error(
      'Cartão salvo: use cartão novo na automação ou desative AUTOMATION_API_URL para API direta.',
    );
  }

  const pamInfo = cardToPamInfo(card);
  const rechargeValue = rechargeValueFromCents(productValue);

  const data = await startWebLinkRecharge(apiUrl, {
    loginUrl,
    accessNumber: msisdn,
    rechargeValue,
    pamInfo,
    browser,
  });

  const mapped = mapAutomationStatus(data);
  const gate = data?.paymentResult ?? {};

  return {
    mode: 'browser',
    sessionId: data.sessionId,
    paymentId: gate?.gateNsu ?? null,
    pending: null,
    result: mapped,
    valueCents: productValue,
    latencyMs: Date.now() - startedAt,
    cardMask: maskFromPam(pamInfo),
    automation: {
      status: data.status,
      step: data.step,
      stepLabel: data.stepLabel,
      gateCode: data.gateCode ?? gate?.gateCode ?? null,
      gateMessage: data.gateMessage ?? gate?.gateMessage ?? null,
      gateNsu: data.gateNsu ?? gate?.gateNsu ?? null,
      claroErrorCode: data.claroErrorCode ?? null,
    },
  };
}
