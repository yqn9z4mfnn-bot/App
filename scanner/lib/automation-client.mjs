const DEFAULT_TIMEOUT_MS = 180_000;

function normalizeBaseUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text.slice(0, 500) || `HTTP ${res.status}`);
  }
}

/** Verifica se a API de automação (Playwright) está online. */
export async function checkAutomationHealth(apiUrl, timeoutMs = 8000) {
  const base = normalizeBaseUrl(apiUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/health`, { signal: controller.signal });
    if (!res.ok) return { ok: false, status: res.status };
    const body = await readJson(res);
    return { ok: Boolean(body.ok), ...body };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Recarga via automação Playwright (mesmo fluxo do server.js / automation.js).
 * POST /api/session/start-web-link
 */
export async function startWebLinkRecharge(
  apiUrl,
  {
    loginUrl,
    accessNumber,
    rechargeTargetNumber,
    rechargeValue,
    pamInfo,
    browser,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  },
) {
  const base = normalizeBaseUrl(apiUrl);
  const msisdn = String(accessNumber).replace(/\D/g, '');
  const target = String(rechargeTargetNumber ?? msisdn).replace(/\D/g, '');

  const body = {
    loginUrl,
    link: loginUrl,
    accessNumber: msisdn,
    claroNumber: msisdn,
    rechargeTargetNumber: target,
    rechargeValue: String(rechargeValue),
    pamInfo,
  };
  if (browser) body.browser = browser;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${base}/api/session/start-web-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await readJson(res);
    if (!res.ok) {
      throw new Error(data.error || data.message || `Automação HTTP ${res.status}`);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Timeout na automação (>3 min) — checkout ainda processando?');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
