export function fetchErrorText(err) {
  return [err?.message, err?.code, err?.cause?.message, err?.cause?.code, err?.cause?.cause?.message]
    .filter(Boolean)
    .join(' ');
}

export function isTransientFetchError(err) {
  return /429|Too Many|Timeout|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR|socket|EPIPE|ENOTFOUND|EAI_AGAIN|other side closed|ConnectTimeout|network|aborted/i.test(
    fetchErrorText(err),
  );
}

import { proxyEnabled } from './proxy.mjs';

function networkFailureLabel() {
  return proxyEnabled() ? 'Falha de rede no proxy' : 'Falha de rede na API';
}

export function formatFetchError(err) {
  const text = fetchErrorText(err);
  if (/ECONNREFUSED.*\b3000\b|127\.0\.0\.1:3000|localhost:3000/i.test(text)) {
    return 'Automação indisponível (serviço parado)';
  }
  if (/timeout|aborted|ConnectTimeout/i.test(text)) {
    return proxyEnabled() ? 'Timeout na API (proxy/rede)' : 'Timeout na API';
  }
  if (/fetch failed|ECONNRESET|UND_ERR|socket|other side closed|EPIPE|ECONNREFUSED/i.test(text)) {
    return networkFailureLabel();
  }
  return String(err?.message || err);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
