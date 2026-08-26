import { proxiedFetch } from './proxy.mjs';

const CLARO_API = 'https://claro-recarga-api.m4u.com.br';
const CHANNEL = 'MINHA_CLARO_WEB';
const DEFAULT_TIMEOUT_MS = 15_000;

export async function request(url, options = {}) {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const { timeoutMs: _ignored, signal: _sig, ...rest } = options;
    const res = await proxiedFetch(url, {
      ...rest,
      signal: controller.signal,
      headers: {
        channel: CHANNEL,
        accept: 'application/json',
        ...options.headers,
      },
    });

    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    return {
      ok: res.ok,
      status: res.status,
      body,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Timeout na API Claro');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function claroHeaders(sessionId) {
  const headers = {
    channel: CHANNEL,
    'content-type': 'application/json',
  };
  if (sessionId) {
    headers.authorization = `claro ${sessionId}`;
  }
  return headers;
}

export async function claroGet(path, sessionId) {
  return request(`${CLARO_API}${path}`, { headers: claroHeaders(sessionId) });
}

export async function claroPost(path, sessionId, payload) {
  return request(`${CLARO_API}${path}`, {
    method: 'POST',
    headers: claroHeaders(sessionId),
    body: JSON.stringify(payload),
  });
}

export async function claroDelete(path, sessionId) {
  return request(`${CLARO_API}${path}`, {
    method: 'DELETE',
    headers: claroHeaders(sessionId),
  });
}

export { CLARO_API, CHANNEL };
