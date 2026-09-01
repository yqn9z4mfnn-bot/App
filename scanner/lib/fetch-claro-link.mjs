import './load-env.mjs';
import { proxiedFetch, describeProxy, proxyEnabled, proxyAllTraffic, proxyPaymentOnly, getPaymentProxyUrl, resetProxyAgent } from './proxy.mjs';
import { formatFetchError, isTransientFetchError, sleep } from './transient-fetch.mjs';

const DEFAULT_LINK_API = 'https://sarcastic-pertinaciously-shawnda.ngrok-free.dev';
const MINHACLARO_PORTAL = 'https://clarorecarga.claro.com.br/minhaclaro_web';

/** Força portal minhaclaro_web (substitui controle_web no link ou monta URL a partir do JWT). */
export function normalizeMinhaClaroWebLink(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^eyJ/i.test(s)) {
    return `${MINHACLARO_PORTAL}/select-login?t=${s}`;
  }
  if (/^https?:\/\//i.test(s)) {
    return s.replace(/\/controle_web\//gi, '/minhaclaro_web/');
  }
  return s;
}

export function normalizeBrMobile(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }
  if (digits.length === 10) {
    digits = `${digits.slice(0, 2)}9${digits.slice(2)}`;
  }
  if (digits.length !== 11) return null;
  return digits;
}

export function looksLikeMsisdn(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.includes('|')) return false;
  if (/clarorecarga|select-login|^eyJ/i.test(trimmed)) return false;
  return Boolean(normalizeBrMobile(trimmed));
}

async function logLinkProxyContext(label, attempt) {
  if (proxyPaymentOnly() || !proxyEnabled()) {
    console.warn(`[link] ${label} attempt=${attempt} — proxy OFF (IP direto)`);
    return null;
  }
  if (String(process.env.PROXY_LOG_IP || '0') === '0') return null;
  console.log(`[link] ${label} attempt=${attempt} proxy=${describeProxy()}`);
  return null;
}

export async function fetchClaroLoginLink(msisdn, { timeoutMs } = {}) {
  const number = normalizeBrMobile(msisdn);
  if (!number) {
    throw new Error('Número inválido. Use DDD + 9 dígitos, ex: 38991121276');
  }

  if (proxyEnabled() && !getPaymentProxyUrl()) {
    throw new Error('PROXY_ENABLED=1 mas PROXY_SERVER/PORT/USER/PASS incompletos no .env');
  }

  const defaultTimeout = Number(process.env.CLARO_LINK_TIMEOUT_MS) || 20_000;
  const waitMs = timeoutMs ?? defaultTimeout;
  const configuredRetries = Number(process.env.CLARO_LINK_429_RETRIES) || 5;
  const maxRetries = proxyAllTraffic() ? configuredRetries : Math.min(configuredRetries, 2);
  const base = String(process.env.CLARO_LINK_API ?? DEFAULT_LINK_API).replace(/\/+$/, '');
  const url = `${base}/claro/link/${number}`;

  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), waitMs);
    try {
      await logLinkProxyContext(`msisdn=${number}`, attempt);

      const res = await proxiedFetch(url, {
        rotateIp: attempt > 1,
        headers: {
          accept: 'application/json',
          'ngrok-skip-browser-warning': 'true',
        },
        signal: controller.signal,
      });
      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Gerador de link retornou HTML/texto (${res.status})`);
      }
      if (res.status === 429) {
        lastErr = new Error(body.error || body.message || 'Rate limit (429) ao gerar link Claro');
        if (attempt < maxRetries) {
          const delay = Number(process.env.CLARO_LINK_429_BACKOFF_MS) || 1500;
          console.warn(`[link] 429 — nova IP em ${delay * attempt}ms (tentativa ${attempt}/${maxRetries})`);
          await new Promise((r) => setTimeout(r, delay * attempt));
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) {
        throw new Error(body.error || body.message || `Gerador de link HTTP ${res.status}`);
      }
      const link = body.link || body.url || body.loginUrl;
      if (!link || (!/[?&]t=/.test(String(link)) && !/^eyJ/.test(String(link)))) {
        throw new Error('Gerador de link não devolveu JWT');
      }
      const normalized = normalizeMinhaClaroWebLink(link) || String(link);
      return { msisdn: number, link: normalized };
    } catch (err) {
      if (err.name === 'AbortError') {
        lastErr = new Error('Timeout ao gerar o link Claro');
      } else {
        lastErr = err;
      }
      const retryable =
        isTransientFetchError(err) ||
        /429|Too Many|rate limit|Timeout/i.test(String(lastErr.message));
      if (attempt < maxRetries && retryable) {
        const delay = Number(process.env.CLARO_LINK_429_BACKOFF_MS) || 1500;
        console.warn(
          `[link] ${formatFetchError(lastErr)} — retry ${attempt}/${maxRetries} em ${delay * attempt}ms`,
        );
        resetProxyAgent();
        await sleep(delay * attempt);
        continue;
      }
      if (err.name === 'AbortError') throw lastErr;
      throw new Error(formatFetchError(err));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr || new Error('Falha ao gerar link Claro');
}
