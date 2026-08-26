const DEFAULT_TIMEOUT_MS = Number(process.env.AUTOMATION_TIMEOUT_MS || 420_000);

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Aguarda automação ficar online (retries entre reinícios do servidor). */
export async function waitForAutomationHealth(apiUrl, { attempts = 5, delayMs = 2000 } = {}) {
  let last = { ok: false };
  for (let i = 0; i < attempts; i++) {
    last = await checkAutomationHealth(apiUrl);
    if (last.ok) return last;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return last;
}

/** Consulta sessão ativa após timeout do bot (automação pode continuar em background). */
async function fetchRunningSessionHint(apiUrl) {
  const base = normalizeBaseUrl(apiUrl);
  try {
    const res = await fetch(`${base}/api/sessions`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await readJson(res);
    const sessions = data?.sessions ?? [];
    const running = sessions.find((s) => s.status === 'running') ?? sessions[0];
    if (!running) return null;
    return `${running.stepLabel || running.step || running.status} (idle ${running.idleForSeconds ?? '?'}s)`;
  } catch {
    return null;
  }
}

/**
 * Inicia recarga via link web (Playwright) — POST /api/session/start-web-link
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
      const hint = await fetchRunningSessionHint(base);
      const mins = Math.round(timeoutMs / 60_000);
      if (hint && /aguardando_gate|pagar|checkout|valor/i.test(hint)) {
        throw new Error(
          `Timeout do bot (${mins} min) — automação ainda rodando: ${hint}. ` +
            'Checkout lento; aguarde ou feche a sessão na API.',
        );
      }
      throw new Error(
        `Timeout do bot (${mins} min) — automação ainda processando${hint ? `: ${hint}` : ''}`,
      );
    }
    const msg = String(err?.message ?? err);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|connect/i.test(msg)) {
      throw new Error(
        `Automação offline (${base}) — suba: cd scanner/automation-server && node server.js`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
