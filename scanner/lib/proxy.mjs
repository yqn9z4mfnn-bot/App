import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { randomBytes } from 'node:crypto';

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

function proxyEnabled() {
  const enabled = (env('PROXY_ENABLED') || '').toLowerCase();
  return enabled === '1' || enabled === 'true' || enabled === 'yes';
}

function proxyRotateDefault() {
  const raw = env('PROXY_ROTATE');
  if (raw == null || raw === '') return proxyEnabled();
  return ['1', 'true', 'yes'].includes(raw.toLowerCase());
}

/** Monta username Smartproxy — sem session = IP novo por conexão. */
function buildProxyUsername(baseUser, { rotateIp = false } = {}) {
  const user = String(baseUser ?? '').trim();
  if (!user || !rotateIp) return user;
  if (/-session-/i.test(user)) return user;
  const token = randomBytes(4).toString('hex');
  return `${user}-session-${token}`;
}

export function getProxyUrl(opts = {}) {
  if (!proxyEnabled()) return null;
  const explicit = env('PROXY_URL');
  if (explicit) return explicit;

  const host = env('PROXY_SERVER') || env('PROXY_HOST');
  const port = env('PROXY_PORT');
  if (!host || !port) return null;

  const user = buildProxyUsername(env('PROXY_USERNAME') || env('PROXY_USER'), opts);
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
  const rotate = proxyRotateDefault() ? ' rotate' : '';
  if (env('PROXY_URL')) {
    try {
      const u = new URL(env('PROXY_URL'));
      return `${u.hostname}:${u.port || '3120'}${rotate}`;
    } catch {
      return `PROXY_URL${rotate}`;
    }
  }
  if (host && port) return `${host}:${port}${rotate}`;
  return null;
}

function createProxyAgent(uri, { rotateIp = false } = {}) {
  return new ProxyAgent({
    uri,
    requestTls: { timeout: envInt('PROXY_REQUEST_TIMEOUT_MS', 15_000) },
    connectTimeout: envInt('PROXY_CONNECT_TIMEOUT_MS', 10_000),
    pipelining: rotateIp ? 0 : 1,
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
      console.log(
        `[proxy] ativo ${describeProxy()?.replace(' rotate', '')}${proxyRotateDefault() ? ' (rotate por req no link)' : ''}`,
      );
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

/** fetch via Smartproxy quando PROXY_* está definido; senão fetch normal. */
export async function proxiedFetch(url, options = {}) {
  const { rotateIp = false, ...fetchOpts } = options;
  const shouldRotate = rotateIp || proxyRotateDefault();
  const dispatcher = getProxyDispatcher({ rotateIp: shouldRotate });

  if (!dispatcher) return fetch(url, fetchOpts);

  if (shouldRotate) {
    try {
      return await undiciFetch(url, { ...fetchOpts, dispatcher });
    } finally {
      await dispatcher.close().catch(() => {});
    }
  }

  return undiciFetch(url, { ...fetchOpts, dispatcher });
}
