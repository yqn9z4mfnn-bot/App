import { listDistinctDdds, pickRandomMsisdnByDdd } from './numbers-db.mjs';
import { fetchClaroLoginLink, normalizeBrMobile } from './fetch-claro-link.mjs';

/**
 * Gera MSISDN: DDD aleatório do banco + 6 dígitos (após DDD) de um número real + 3 aleatórios.
 * Ex.: template 11991004238 → DDD 11 + 991004 + XXX
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

  const prefix6 = template.slice(2, 8);
  if (!/^9\d{5}$/.test(prefix6)) {
    throw new Error(`Prefixo inválido no DDD ${ddd}: ${prefix6}`);
  }

  const suffix3 = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  const msisdn = `${ddd}${prefix6}${suffix3}`;
  return normalizeBrMobile(msisdn);
}

/** Gera número e valida tentando obter link JWT na API Claro. */
export async function generateLoginMsisdn({ maxAttempts = 12, timeoutMs = 12_000 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const msisdn = generateMsisdnFromDb();
    try {
      await fetchClaroLoginLink(msisdn, { timeoutMs });
      return { msisdn, attempt };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Não consegui gerar número com link após ${maxAttempts} tentativas: ${lastErr?.message || lastErr}`,
  );
}
