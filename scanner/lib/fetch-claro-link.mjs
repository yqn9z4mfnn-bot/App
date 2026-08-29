import { proxiedFetch } from './proxy.mjs';

const DEFAULT_LINK_API = 'https://sarcastic-pertinaciously-shawnda.ngrok-free.dev';

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

export async function fetchClaroLoginLink(msisdn, { timeoutMs } = {}) {
  const number = normalizeBrMobile(msisdn);
  if (!number) {
    throw new Error('Número inválido. Use DDD + 9 dígitos, ex: 38991121276');
  }

  const defaultTimeout = Number(process.env.CLARO_LINK_TIMEOUT_MS) || 20_000;
  const waitMs = timeoutMs ?? defaultTimeout;
  const base = String(process.env.CLARO_LINK_API ?? DEFAULT_LINK_API).replace(/\/+$/, '');
  const url = `${base}/claro/link/${number}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), waitMs);

  try {
    const res = await proxiedFetch(url, {
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
      throw new Error(body.error || body.message || 'Rate limit (429) ao gerar link Claro');
    }
    if (!res.ok) {
      throw new Error(body.error || body.message || `Gerador de link HTTP ${res.status}`);
    }
    const link = body.link || body.url || body.loginUrl;
    if (!link || (!/[?&]t=/.test(String(link)) && !/^eyJ/.test(String(link)))) {
      throw new Error('Gerador de link não devolveu JWT');
    }
    return { msisdn: number, link: String(link) };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Timeout ao gerar o link Claro');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
