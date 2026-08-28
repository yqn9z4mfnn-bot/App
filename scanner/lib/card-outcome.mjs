/** Classifica o que fazer com o cartão da fila TXT após a recarga. */
export function classifyCardListAction({ outcome, error } = {}) {
  if (error) {
    const msg = String(error?.message ?? error);
    if (/negad|denied|recusad|não autoriz|bloqueado|insuficiente/i.test(msg)) return 'consumed';
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

  if (status === 'DENIED' || gateCode === 'DENIED') return 'consumed';
  if (/^DENIED$/i.test(String(result.status ?? ''))) return 'consumed';

  if (isGateDenialMessage(msg) || gateIndicatesDenial(raw)) return 'consumed';

  if (status === 'TIMEOUT' || rawStatus === 'timeout') return 'return';
  if (status === 'AUTOMATION_FAIL') return 'return';

  if (rawStatus === 'error' || status === 'ERROR' || status === 'PENDING') {
    if (isAutomationFailureMessage(msg)) return 'return';
    if (raw.gateResponse?.body || raw.gateResponse?.httpStatus) return 'consumed';
    if (isGateDenialMessage(msg)) return 'consumed';
    return 'return';
  }

  // SSE/API direta
  const sseStatus = String(result.status ?? '').toUpperCase();
  if (sseStatus === 'DENIED' || sseStatus === 'REJECTED' || sseStatus === 'FAILURE') {
    return 'consumed';
  }

  return 'return';
}

function isGateDenialMessage(msg) {
  return /negad|denied|recusad|não autoriz|bloqueado|insuficiente|saldo insuficiente|cartão inválido|transação negada|operadora recusou/i.test(
    String(msg),
  );
}

function isAutomationFailureMessage(msg) {
  return /não capturado|iframe|element|click|limite de \d+ telas|timeout no pagamento|automação http|paminfo|error_manual|sessão|manual|playwright|browser/i.test(
    String(msg),
  );
}

function gateIndicatesDenial(raw) {
  if (!raw?.gateResponse?.body) return false;
  const b = raw.gateResponse.body;
  const st = String(b.status ?? b.payments?.[0]?.status ?? b.tags?.transaction?.status ?? '').toUpperCase();
  return st === 'DENIED' || st === 'REJECTED' || st === 'FAILURE';
}

export function cardListActionLabel(action) {
  if (action === 'approved') return '✅ aprovado → salvo em cards-approved.txt';
  if (action === 'consumed') return '🚫 negado na gate → removido da fila';
  if (action === 'return') return '↩️ falha de automação → cartão mantido na fila';
  return '';
}
