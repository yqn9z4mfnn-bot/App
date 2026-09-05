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

/** Proxy ativo mas restrito a pagamento (Eldorado/browser checkout). */
export function proxyPaymentOnly() {
  const raw = (env('PROXY_PAYMENT_ONLY') || '').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** Proxy em todo tráfego HTTP (legado). */
export function proxyAllTraffic() {
  return proxyEnabled() && !proxyPaymentOnly();
}

const PAYMENT_HTTP_RE =
  /eldorado\.m4u|smart-checkout(?:-dev)?\.bemobi\.com|\/tokenizer\/|\/api-bsc\/api\/v1\/(?:payments|cards|installments)|bemobi\.com\/api\/v1\/session/i;

export function isPaymentHttpUrl(url) {
  return PAYMENT_HTTP_RE.test(String(url ?? ''));
}

/** Decide se uma requisição HTTP deve sair pelo proxy. */
export function shouldProxyHttp(url, options = {}) {
  if (options.useProxy === true) return proxyEnabled() && Boolean(getProxyUrl({ ignoreScope: true }));
  if (options.useProxy === false) return false;
  if (!proxyEnabled()) return false;
  if (proxyPaymentOnly()) return isPaymentHttpUrl(url);
  return true;
}

function proxyRotateDefault() {
  const raw = env('PROXY_ROTATE');
  if (raw == null || raw === '') return proxyAllTraffic();
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

  return { host, port, user, pass };
}

function buildPlaywrightProxyConfig(opts = {}) {
  const { host, port, user, pass } = proxyParts({ rotateIp: false, ...opts });
  if (!host || !port) return undefined;
  const proxy = { server: `http://${host}:${port}` };
  if (user && pass) {
    proxy.username = user;
    proxy.password = pass;
  }
  return proxy;
}

/** Config de proxy para Playwright (sem credencial na URL / no argv). */
export function getPlaywrightProxy(opts = {}) {
  if (!proxyEnabled()) return undefined;
  if (proxyPaymentOnly()) {
    const flow = String(
      opts.browserFlow ?? process.env.RECHARGE_BROWSER_FLOW ?? 'checkout-link',
    ).toLowerCase();
    // weblink abre portal Claro no browser — proxy só no pagamento (checkout-link).
    if (flow === 'weblink') return undefined;
  }
  return buildPlaywrightProxyConfig(opts);
}

export function getProxyUrl(opts = {}) {
  const { ignoreScope = false, ...rest } = opts;
  if (!proxyEnabled()) return null;
  if (!ignoreScope && proxyPaymentOnly()) return null;

  const { host, port, user, pass } = proxyParts(rest);
  if (!host || !port) return null;

  if (user && pass) {
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  return `http://${host}:${port}`;
}

/** URL do proxy para pagamento (ignora PROXY_PAYMENT_ONLY). */
export function getPaymentProxyUrl(opts = {}) {
  if (!proxyEnabled()) return null;
  const { host, port, user, pass } = proxyParts(opts);
  if (!host || !port) return null;
  if (user && pass) {
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  return `http://${host}:${port}`;
}

export function describeProxy() {
  const uri = getPaymentProxyUrl();
  if (!uri) return null;
  const { host, port } = proxyParts();
  const rotate = proxyRotateDefault() ? ' rotate' : '';
  const scope = proxyPaymentOnly() ? ' payment-only' : '';
  if (host && port) return `${host}:${port}${scope}${rotate}`;
  return `proxy${scope}${rotate}`;
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

export function resetProxyAgent() {
  const prev = sharedAgent;
  sharedAgent = null;
  if (prev) prev.close().catch(() => {});
}

export function getProxyDispatcher({ rotateIp = false, payment = false } = {}) {
  const uri = payment || proxyAllTraffic() ? getPaymentProxyUrl({ rotateIp }) : getProxyUrl({ rotateIp });
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
  const uri = getPaymentProxyUrl({ rotateIp });
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
  if (required && !getPaymentProxyUrl()) {
    throw new Error('PROXY_REQUIRED=1 mas PROXY_ENABLED/dados do proxy não estão configurados no .env');
  }
}

/** fetch via Smartproxy quando PROXY_* está definido; senão fetch normal. */
export async function proxiedFetch(url, options = {}) {
  const { rotateIp = false, ...fetchOpts } = options;
  const useProxy = shouldProxyHttp(url, options);
  const shouldRotate =
    useProxy && (rotateIp === true || (rotateIp !== false && proxyRotateDefault()));

  assertProxyWhenRequired();

  const dispatcher = useProxy
    ? shouldRotate
      ? getProxyDispatcher({ rotateIp: true, payment: true })
      : getProxyDispatcher({ rotateIp: false, payment: true })
    : undefined;

  if (!dispatcher) {
    if (rotateIp && useProxy && proxyEnabled()) {
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
