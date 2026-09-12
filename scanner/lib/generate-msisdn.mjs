import {
  listDistinctDdds,
  pickRandomMsisdnByDdd,
  pickRandomStoredLogin,
  listAllMsisdns,
  listLoginPrefixes,
} from './numbers-db.mjs';
import {
  fetchClaroLoginLink,
  normalizeBrMobile,
  normalizeMinhaClaroWebLink,
} from './fetch-claro-link.mjs';
import { getPaymentProxyUrl, proxyEnabled, proxyAllTraffic } from './proxy.mjs';
import { isTransientFetchError, sleep } from './transient-fetch.mjs';

/**
 * Gera MSISDN: DDD do banco + 5 dígitos após o DDD de um número real + 4 aleatórios.
 * Ex.: template 11991004238 → DDD 11 + 99100 + XXXX
 */
export function generateMsisdnFromDb() {
  const ddds = listDistinctDdds();
  if (!ddds.length) {
    throw new Error('Banco sem DDDs — envie um .txt com números primeiro.');
  }

  const ddd = ddds[Math.floor(Math.random() * ddds.length)];
  const template = pickRandomMsisdnByDdd(ddd);
  if (!template || template.length !== 11) {
    throw new Error(`Sem números no DDD ${ddd} para montar o prefixo.`);
  }

  const prefix5 = template.slice(2, 7);
  if (!/^9\d{4}$/.test(prefix5)) {
    throw new Error(`Prefixo inválido no DDD ${ddd}: ${prefix5}`);
  }

  const suffix4 = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  const msisdn = `${ddd}${prefix5}${suffix4}`;
  return normalizeBrMobile(msisdn);
}

/**
 * Gera N MSISDNs únicos: prefixo de 7 dígitos do banco + 4 aleatórios.
 * Não repete número já salvo.
 */
export function generateUniqueMsisdnsFromPrefixes(count, { existing = null, prefixes = null } = {}) {
  const want = Math.max(0, Number(count) || 0);
  const known = existing ?? listAllMsisdns();
  const prefs = prefixes ?? listLoginPrefixes();
  if (!prefs.length) throw new Error('Banco sem prefixos (DDD+5) para gerar números.');

  const used = new Set(known);
  const out = [];
  const maxTries = Math.max(want * 40, 10_000);
  for (let i = 0; i < maxTries && out.length < want; i += 1) {
    const prefix = prefs[Math.floor(Math.random() * prefs.length)];
    const suffix4 = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const msisdn = normalizeBrMobile(`${prefix}${suffix4}`);
    if (!msisdn || used.has(msisdn)) continue;
    used.add(msisdn);
    out.push(msisdn);
  }
  if (out.length < want) {
    throw new Error(`Só consegui gerar ${out.length}/${want} números únicos com os prefixos atuais.`);
  }
  return out;
}

/** Gera número e valida tentando obter link JWT na API Claro. */
export async function generateLoginMsisdn({
  maxAttempts = 8,
  timeoutMs = 10_000,
  shouldAbort = null,
} = {}) {
  if (proxyEnabled() && !getPaymentProxyUrl()) {
    throw new Error('PROXY_ENABLED=1 mas proxy incompleto no .env');
  }

  const attempts = proxyAllTraffic() ? maxAttempts : Math.min(maxAttempts, 3);
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (shouldAbort?.()) {
      const err = new Error('cancelled');
      err.cancelled = true;
      throw err;
    }
    const msisdn = generateMsisdnFromDb();
    try {
      const { link } = await fetchClaroLoginLink(msisdn, { timeoutMs });
      return { msisdn, link, attempt };
    } catch (err) {
      if (err?.cancelled || shouldAbort?.()) {
        const cancel = new Error('cancelled');
        cancel.cancelled = true;
        throw cancel;
      }
      lastErr = err;
      if (attempt < attempts && isTransientFetchError(err)) {
        await sleep(Number(process.env.CLARO_LINK_429_BACKOFF_MS) || 800);
      }
    }
  }

  const stored = pickRandomStoredLogin();
  if (stored?.link) {
    const link = normalizeMinhaClaroWebLink(stored.link) || String(stored.link);
    console.warn(
      `[generate-msisdn] API falhou (${lastErr?.message || 'sem detalhe'}) — usando login do banco ${stored.msisdn}`,
    );
    return { msisdn: stored.msisdn, link, attempt: 0, source: 'db_stored' };
  }

  throw new Error(
    `Não consegui gerar número com link após ${maxAttempts} tentativas: ${lastErr?.message || lastErr}`,
  );
}
