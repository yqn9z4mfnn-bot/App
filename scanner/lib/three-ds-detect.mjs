const TDS_URL_RE = /\/3ds\/challenge|cardinalcommerce\.com|auth\.visa\.com|src\.mastercard\.com|secure\.checkout\.visa\.com/i;
const TDS_TEXT_RE =
  /valida[cç][aã]o de seguran[cç]a|chave de seguran[cç]a|verifica[cç][aã]o necess[aá]ria|threeDSSessionData|bpmpi_auth|autentica[cç][aã]o 3ds/i;
const TDS_BODY_RE =
  /challengeToken|threeDSChallenge|requiresAuthentication|credit3DS|3dsMode|"3ds"/i;

/** Detecta indícios de 3DS em objeto JSON (resposta API/SSE). */
export function detect3dsInObject(value, depth = 0) {
  if (value == null || depth > 8) return null;

  if (typeof value === 'string') {
    if (TDS_URL_RE.test(value) || TDS_TEXT_RE.test(value)) {
      return { reason: 'campo_3ds', detail: value.slice(0, 120) };
    }
    return null;
  }

  if (typeof value !== 'object') return null;

  try {
    const blob = JSON.stringify(value);
    if (TDS_BODY_RE.test(blob) && (TDS_URL_RE.test(blob) || /challengeToken/i.test(blob))) {
      const brand =
        blob.match(/brand[=:"'\s]+([A-Z]+)/i)?.[1] ??
        blob.match(/(Bradesco|Visa|Master|Elo|Itaú|Santander)/i)?.[1] ??
        'banco';
      return { reason: 'resposta_api', brand, detail: blob.slice(0, 160) };
    }
  } catch {
    /* ignore */
  }

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

export const THREE_DS_BLOCKED_MESSAGE =
  '3DS exigido pelo banco — recarga abortada (autenticação manual não suportada)';
