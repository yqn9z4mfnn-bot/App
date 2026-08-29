import './load-env.mjs';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

let sharedAgent;
let logged = false;

function env(name) {
  const v = process.env[name];
  return v == null || v === '' ? null : String(v);
}

function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function proxyEnabled() {
  const enabled = (env('PROXY_ENABLED') || '').toLowerCase();
  return enabled === '1' || enabled === 'true' || enabled === 'yes';
}

function proxyRotateDefault() {
  const raw = env('PROXY_ROTATE');
  if (raw == null || raw === '') return proxyEnabled();
  return ['1', 'true', 'yes'].includes(raw.toLowerCase());
}

/** Remove session sticky do username — rotação = IP novo por conexão. */
export function normalizeProxyUsername(baseUser) {
  return String(baseUser ?? '')
    .trim()
    .replace(/[-_](session|sessionduration)[-_a-z0-9]*/gi, '');
}

function proxyParts(opts = {}) {
  const host = env('PROXY_SERVER') || env('PROXY_HOST');
  const port = env('PROXY_PORT');
  const pass = env('PROXY_PASSWORD') || env('PROXY_PASS');
  let user = normalizeProxyUsername(env('PROXY_USERNAME') || env('PROXY_USER'));

  const explicit = env('PROXY_URL');
  if (explicit) {
    try {
      const u = new URL(explicit);
      if (u.username) user = normalizeProxyUsername(decodeURIComponent(u.username));
      user = applyStickySession(user, opts);
      if (u.password && !pass) {
        return {
          host: u.hostname,
          port: u.port || port,
          user,
          pass: decodeURIComponent(u.password),
        };
      }
      return {
        host: u.hostname || host,
        port: u.port || port,
        user,
        pass: pass || (u.password ? decodeURIComponent(u.password) : null),
      };
    } catch {
      // fall through
    }
  }

  user = applyStickySession(user, opts);
  return { host, port, user, pass };
}

/** Mesmo IP no HTTP e no Edge quando PROXY_ROTATE=0 (Smartproxy session). */
function applyStickySession(user, { rotateIp = false } = {}) {
  if (!user) return user;
  if (rotateIp || proxyRotateDefault()) return user;
  if (/[-_]session[-_]/i.test(user)) return user;
  const sid = (env('PROXY_SESSION') || 'linkclaro').replace(/[^a-zA-Z0-9]/g, '');
  return sid ? `${user}-session-${sid}` : user;
}

/** Config de proxy para Playwright (sem credencial na URL / no argv). */
export function getPlaywrightProxy(opts = {}) {
  if (!proxyEnabled()) return undefined;
  const { host, port, user, pass } = proxyParts({ rotateIp: false, ...opts });
  if (!host || !port) return undefined;
  const proxy = { server: `http://${host}:${port}` };
  if (user && pass) {
    proxy.username = user;
    proxy.password = pass;
  }
  return proxy;
}

export function getProxyUrl(opts = {}) {
  if (!proxyEnabled()) return null;

  const { host, port, user, pass } = proxyParts(opts);
  if (!host || !port) return null;

  if (user && pass) {
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  return `http://${host}:${port}`;
}

export function describeProxy() {
  if (!getProxyUrl()) return null;
  const { host, port } = proxyParts();
  const rotate = proxyRotateDefault() ? ' rotate' : '';
  if (host && port) return `${host}:${port}${rotate}`;
  return `proxy${rotate}`;
}

function createProxyAgent(uri, { rotateIp = false } = {}) {
  return new ProxyAgent({
    uri,
    requestTls: { timeout: envInt('PROXY_REQUEST_TIMEOUT_MS', 15_000) },
    connectTimeout: envInt('PROXY_CONNECT_TIMEOUT_MS', 10_000),
    pipelining: 0,
    connections: 1,
    keepAliveTimeout: rotateIp ? 1000 : envInt('PROXY_KEEPALIVE_MS', 30_000),
    keepAliveMaxTimeout: rotateIp ? 1000 : envInt('PROXY_KEEPALIVE_MAX_MS', 60_000),
  });
}

export function getProxyDispatcher({ rotateIp = false } = {}) {
  const uri = getProxyUrl({ rotateIp });
  if (!uri) return undefined;

  if (rotateIp) {
    return createProxyAgent(uri, { rotateIp: true });
  }

  if (!sharedAgent) {
    sharedAgent = createProxyAgent(uri, { rotateIp: false });
    if (!logged) {
      logged = true;
      console.log(`[proxy] ativo ${describeProxy()}`);
    }
  }
  return sharedAgent;
}

/** Consulta IP de saída via proxy (debug). */
export async function fetchProxyEgressIp({ rotateIp = true } = {}) {
  const uri = getProxyUrl({ rotateIp });
  if (!uri) return null;
  const agent = createProxyAgent(uri, { rotateIp });
  try {
    const res = await undiciFetch('https://api.ipify.org?format=json', { dispatcher: agent });
    const body = await res.json().catch(() => ({}));
    return body?.ip ? String(body.ip) : null;
  } finally {
    await agent.close().catch(() => {});
  }
}

function assertProxyWhenRequired() {
  const required = ['1', 'true', 'yes'].includes(String(env('PROXY_REQUIRED') || '').toLowerCase());
  if (required && !getProxyUrl()) {
    throw new Error('PROXY_REQUIRED=1 mas PROXY_ENABLED/dados do proxy não estão configurados no .env');
  }
}

/** fetch via Smartproxy quando PROXY_* está definido; senão fetch normal. */
export async function proxiedFetch(url, options = {}) {
  const { rotateIp = false, ...fetchOpts } = options;
  const shouldRotate =
    rotateIp === true || (rotateIp !== false && proxyRotateDefault());

  assertProxyWhenRequired();

  const dispatcher = shouldRotate
    ? getProxyDispatcher({ rotateIp: true })
    : getProxyDispatcher({ rotateIp: false });

  if (!dispatcher) {
    if (rotateIp && proxyEnabled()) {
      throw new Error('Proxy habilitado mas URL inválida — verifique PROXY_SERVER/PORT/USER/PASS no .env');
    }
    return fetch(url, fetchOpts);
  }

  if (shouldRotate) {
    try {
      return await undiciFetch(url, { ...fetchOpts, dispatcher });
    } finally {
      await dispatcher.close().catch(() => {});
    }
  }

  return undiciFetch(url, { ...fetchOpts, dispatcher });
}
