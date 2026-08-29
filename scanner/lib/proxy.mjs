import { fetch as undiciFetch, ProxyAgent } from 'undici';

let agent;
let logged = false;

function env(name) {
  const v = process.env[name];
  return v == null || v === '' ? null : String(v);
}

function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function getProxyUrl() {
  const enabled = (env('PROXY_ENABLED') || '').toLowerCase();
  if (enabled !== '1' && enabled !== 'true' && enabled !== 'yes') return null;
  const explicit = env('PROXY_URL');
  if (explicit) return explicit;

  const host = env('PROXY_SERVER') || env('PROXY_HOST');
  const port = env('PROXY_PORT');
  if (!host || !port) return null;

  const user = env('PROXY_USERNAME') || env('PROXY_USER');
  const pass = env('PROXY_PASSWORD') || env('PROXY_PASS');
  if (user && pass) {
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  return `http://${host}:${port}`;
}

export function describeProxy() {
  if (!getProxyUrl()) return null;
  const host = env('PROXY_SERVER') || env('PROXY_HOST');
  const port = env('PROXY_PORT');
  if (env('PROXY_URL')) {
    try {
      const u = new URL(env('PROXY_URL'));
      return `${u.hostname}:${u.port || '3120'}`;
    } catch {
      return 'PROXY_URL';
    }
  }
  if (host && port) return `${host}:${port}`;
  return null;
}

export function getProxyDispatcher() {
  const uri = getProxyUrl();
  if (!uri) return undefined;
  if (!agent) {
    agent = new ProxyAgent({
      uri,
      requestTls: { timeout: envInt('PROXY_REQUEST_TIMEOUT_MS', 15_000) },
      connectTimeout: envInt('PROXY_CONNECT_TIMEOUT_MS', 10_000),
      keepAliveTimeout: envInt('PROXY_KEEPALIVE_MS', 30_000),
      keepAliveMaxTimeout: envInt('PROXY_KEEPALIVE_MAX_MS', 60_000),
    });
    if (!logged) {
      logged = true;
      console.log(`[proxy] ativo ${describeProxy()}`);
    }
  }
  return agent;
}

/** fetch via Smartproxy quando PROXY_* está definido; senão fetch normal. */
export function proxiedFetch(url, options = {}) {
  const dispatcher = getProxyDispatcher();
  if (!dispatcher) return fetch(url, options);
  return undiciFetch(url, { ...options, dispatcher });
}
