import './load-env.mjs';
import { proxiedFetch, describeProxy, proxyEnabled, proxyAllTraffic, proxyPaymentOnly, fetchProxyEgressIp, resetProxyAgent } from './proxy.mjs';
import { formatFetchError, isTransientFetchError, sleep } from './transient-fetch.mjs';

const CLARO_API = 'https://claro-recarga-api.m4u.com.br';
const CHANNEL = 'MINHA_CLARO_WEB';
const DEFAULT_TIMEOUT_MS = 15_000;

async function logApiProxy(label, url) {
  if (!proxyEnabled() || String(process.env.PROXY_LOG_IP || '0') === '0') return;
  const scope = proxyPaymentOnly() ? 'payment-only' : 'all';
  if (String(process.env.PROXY_LOG_IP || '0') === 'verbose') {
    const ip = await fetchProxyEgressIp({ rotateIp: false }).catch(() => null);
    console.log(`[claro-api] ${label} proxy=${describeProxy() || 'OFF'} scope=${scope} ip=${ip || '?'}`);
    return;
  }
  console.log(`[claro-api] ${label} proxy=${describeProxy() || 'OFF'} scope=${scope} url=${String(url ?? '').slice(0, 80)}`);
}

export async function request(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? Number(process.env.CLARO_HTTP_RETRIES || 3);
  const { timeoutMs: _t, signal: _s, rotateIp, logLabel, retries: _r, ...rest } = options;

  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      if (logLabel && attempt === 1) await logApiProxy(logLabel, url);

      const res = await proxiedFetch(url, {
        ...rest,
        rotateIp: rotateIp === true,
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
      lastErr = err;
      const timeout = err?.name === 'AbortError';
      if (attempt < retries && (timeout || isTransientFetchError(err))) {
        console.warn(
          `[claro-api] ${timeout ? 'timeout' : 'rede'} ${attempt}/${retries}: ${formatFetchError(err)}`,
        );
        resetProxyAgent();
        await sleep(400 * attempt);
        continue;
      }
      if (timeout) throw new Error('Timeout na API Claro');
      throw new Error(formatFetchError(err));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr ?? new Error(formatFetchError(lastErr) || 'Falha de rede na API');
}

function claroHeaders(sessionId) {
  const headers = {
    channel: CHANNEL,
    'content-type': 'application/json',
  };
  if (sessionId) {
    headers.authorization = `claro ${sessionId}`;
  }
  return headers;
}

export async function claroGet(path, sessionId, opts = {}) {
  return request(`${CLARO_API}${path}`, { headers: claroHeaders(sessionId), ...opts });
}

export async function claroPost(path, sessionId, payload, opts = {}) {
  return request(`${CLARO_API}${path}`, {
    method: 'POST',
    headers: claroHeaders(sessionId),
    body: JSON.stringify(payload),
    ...opts,
  });
}

export async function claroDelete(path, sessionId, opts = {}) {
  return request(`${CLARO_API}${path}`, {
    method: 'DELETE',
    headers: claroHeaders(sessionId),
    ...opts,
  });
}
