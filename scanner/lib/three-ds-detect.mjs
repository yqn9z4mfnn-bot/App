/** Sinais explícitos de bloqueio 3DS manual — NÃO confundir com init Braspag (challengeToken). */
const TDS_BLOCK_STATUS_RE =
  /^(3DS_BLOCKED|3DS_CHALLENGE|AUTHENTICATION_REQUIRED|CHALLENGE_REQUIRED)$/i;
const TDS_BLOCK_MESSAGE_RE =
  /valida[cç][aã]o de seguran[cç]a|chave de seguran[cç]a|autentica[cç][aã]o 3ds|challenge 3ds/i;

export const THREE_DS_BLOCKED_MESSAGE =
  '3DS exigido pelo banco — recarga abortada (autenticação manual não suportada)';

/** Detecta bloqueio 3DS real em resposta API/SSE (não tokens Braspag de rotina). */
export function detect3dsInObject(value, depth = 0) {
  if (value == null || depth > 8) return null;

  if (typeof value === 'object' && !Array.isArray(value)) {
    const status = String(value.status ?? value.paymentStatus ?? '').trim();
    const message = String(value.message ?? value.reason ?? value.negativeReason ?? '');
    if (TDS_BLOCK_STATUS_RE.test(status)) {
      return { reason: 'status', brand: value.brand ?? null, detail: status };
    }
    if (TDS_BLOCK_MESSAGE_RE.test(message)) {
      return { reason: 'message', brand: value.brand ?? null, detail: message.slice(0, 120) };
    }
  }

  if (typeof value === 'string') {
    if (TDS_BLOCK_MESSAGE_RE.test(value)) {
      return { reason: 'text', detail: value.slice(0, 120) };
    }
    return null;
  }

  if (typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40)) {
      const hit = detect3dsInObject(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  for (const v of Object.values(value).slice(0, 40)) {
    const hit = detect3dsInObject(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}
