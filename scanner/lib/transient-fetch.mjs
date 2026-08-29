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

export function formatFetchError(err) {
  const text = fetchErrorText(err);
  if (/timeout|aborted|ConnectTimeout/i.test(text)) return 'Timeout na API (proxy/rede)';
  if (/fetch failed|ECONNRESET|UND_ERR|socket|other side closed|EPIPE|ECONNREFUSED/i.test(text)) {
    return 'Falha de rede no proxy';
  }
  return String(err?.message || err);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
