import { listDistinctDdds, pickRandomMsisdnByDdd } from './numbers-db.mjs';
import { fetchClaroLoginLink, normalizeBrMobile } from './fetch-claro-link.mjs';
import { getProxyUrl, proxyEnabled } from './proxy.mjs';
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

/** Gera número e valida tentando obter link JWT na API Claro. */
export async function generateLoginMsisdn({
  maxAttempts = 8,
  timeoutMs = 10_000,
  shouldAbort = null,
} = {}) {
  if (proxyEnabled() && !getProxyUrl()) {
    throw new Error('PROXY_ENABLED=1 mas proxy incompleto no .env');
  }

  const attempts = proxyEnabled() ? maxAttempts : Math.min(maxAttempts, 3);
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
  throw new Error(
    `Não consegui gerar número com link após ${maxAttempts} tentativas: ${lastErr?.message || lastErr}`,
  );
}
