const DEFAULT_BASE = 'https://api.pushinpay.com.br';

/** @param {Record<string, unknown> | null | undefined} data */
function formatPushinApiError(data, httpStatus) {
  const base =
    (typeof data?.message === 'string' && data.message) ||
    (typeof data?.error === 'string' && data.error) ||
    (typeof data?.raw === 'string' ? data.raw.slice(0, 200) : null) ||
    `HTTP ${httpStatus}`;
  const codexRaw = typeof data?.codex === 'string' ? data.codex : '';
  const cpx = codexRaw.match(/#?(CPX\d+)/i)?.[1]?.toUpperCase() ?? '';
  let msg = base;
  if (cpx) msg += ` (${cpx})`;
  if (/temporariamente indispon/i.test(String(base)) || cpx) {
    msg +=
      ' — confira no painel PushinPay (conta aprovada, limites, whitelist de IP da nuvem) ou abra suporte informando o código CPX.';
  }
  return msg;
}

function apiBase() {
  return String(process.env.PUSHINPAY_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
}

function bearerToken() {
  const t = String(process.env.PUSHINPAY_TOKEN || '').trim();
  if (!t) throw new Error('PUSHINPAY_TOKEN não configurado');
  return t;
}

function pushinFetchTimeoutMs() {
  const n = Number(process.env.PUSHINPAY_FETCH_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 5000 ? n : 45_000;
}

function pushinRetryAttempts() {
  const n = Number(process.env.PUSHINPAY_RETRY_ATTEMPTS);
  return Number.isFinite(n) && n >= 1 ? Math.min(8, Math.round(n)) : 4;
}

function isRetryablePushinHttp(status) {
  return status === 429 || status === 502 || status === 503 || status === 504 || status === 520;
}

function retryDelayMs(attemptIndex) {
  return Math.min(12_000, 800 + attemptIndex * 1400);
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function pushinFetch(url, init = {}) {
  const attempts = pushinRetryAttempts();
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), pushinFetchTimeoutMs());
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (isRetryablePushinHttp(res.status) && i + 1 < attempts) {
        await sleep(retryDelayMs(i));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      const retryable =
        err?.name === 'AbortError' ||
        err?.code === 'ETIMEDOUT' ||
        err?.code === 'ECONNRESET' ||
        /fetch failed/i.test(String(err?.message ?? ''));
      if (retryable && i + 1 < attempts) {
        await sleep(retryDelayMs(i));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error('PushinPay: falha após retentativas');
}

export function pushinPayConfigured() {
  return Boolean(String(process.env.PUSHINPAY_TOKEN || '').trim());
}

/**
 * @param {{ valueCents: number, webhookUrl?: string, description?: string }} opts
 */
export async function createPixCashIn({ valueCents, webhookUrl, description }) {
  const value = Math.round(Number(valueCents));
  if (!Number.isFinite(value) || value < 50) {
    throw new Error('Valor mínimo do PIX: R$ 0,50 (50 centavos)');
  }
  const body = {
    value,
    split_rules: [],
  };
  if (webhookUrl) body.webhook_url = webhookUrl;
  if (description) body.description = String(description).slice(0, 255);

  const res = await pushinFetch(`${apiBase()}/api/pix/cashIn`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerToken()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`PushinPay: ${formatPushinApiError(data, res.status)}`);
  }
  return data;
}

/** Consulta status (máx. ~1/min por transação — use após o cliente pagar). */
export async function fetchPushinTransaction(transactionId) {
  const id = String(transactionId ?? '').trim();
  if (!id) throw new Error('id da transação ausente');
  const res = await pushinFetch(`${apiBase()}/api/transactions/${encodeURIComponent(id)}`, {
    headers: {
      Authorization: `Bearer ${bearerToken()}`,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`PushinPay: ${formatPushinApiError(data, res.status)}`);
  }
  return data;
}
