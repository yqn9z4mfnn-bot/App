/** Página de erro do checkout Eldorado/Claro — não é VBV/3DS. */

export const CHECKOUT_ERROR_URL_RE =
  /\/bsc\/checkout\/error(?:\?|$|\/)|\/checkout\/error(?:\?|$|\/)|pagamento-erro/i;

export const CHECKOUT_ERROR_TEXT_RE =
  /n[aã]o foi poss[ií]vel concluir|n[aã]o foi poss[ií]vel processar|n[aã]o conseguimos (processar|realizar)|infelizmente n[aã]o conseguimos|pagamento recusad|transa[cç][aã]o negad|cart[aã]o recusad|algo deu errado|compra n[aã]o conclu[ií]da|negada com informa[cç][aã]o|sua compra n[aã]o p[oô]de ser conclu[ií]da|informe c[oó]digo\s*\d+|ligue no n[uú]mero informado no verso/i;

const DEFAULT_HINT = 'Não foi possível concluir o pagamento';

export function isCheckoutErrorUrl(url) {
  return CHECKOUT_ERROR_URL_RE.test(String(url || ''));
}

export function isCheckoutErrorText(text) {
  return CHECKOUT_ERROR_TEXT_RE.test(String(text || ''));
}

export function looksLikeCheckoutError({ url, message } = {}) {
  return isCheckoutErrorUrl(url) || isCheckoutErrorText(message);
}

export function checkoutErrorHint(text, fallback = DEFAULT_HINT) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return fallback;
  const code = t.match(/informe c[oó]digo\s*(\d+)/i);
  if (code) return `Compra não concluída (código ${code[1]})`;
  const m =
    t.match(/compra n[aã]o conclu[ií]da[^.!]*/i) ||
    t.match(/n[aã]o foi poss[ií]vel concluir[^.!]*/i) ||
    t.match(/infelizmente n[aã]o conseguimos[^.!]*/i) ||
    t.match(/n[aã]o conseguimos (processar|realizar)[^.!]*/i);
  return String(m?.[0] || t).slice(0, 120);
}

/** Se a URL/texto for erro de checkout, o resultado 3DS deve virar erro de pagamento. */
export function overrideThreedsIfCheckoutError(result, { url, text } = {}) {
  if (!result || result.status === 'success') return result;
  const pageUrl = url || result.url || '';
  const hintSource = text || result.gateMessage || result.message || '';
  if (!looksLikeCheckoutError({ url: pageUrl, message: hintSource })) return result;
  const hint = checkoutErrorHint(hintSource);
  return {
    ...result,
    status: 'error',
    url: pageUrl || result.url,
    gateCode: result.gateCode && result.gateCode !== '3DS' ? result.gateCode : 'ERROR',
    gateMessage: hint,
    message: hint,
    pagamentoErro: true,
    visualVbv: false,
    requiresImmediateAction: false,
    threeDs: result.threeDs
      ? { ...result.threeDs, supersededBy: 'checkout_error' }
      : undefined,
  };
}
