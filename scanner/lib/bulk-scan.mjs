import { fetchClaroLoginLink, normalizeBrMobile } from './fetch-claro-link.mjs';
import { parseLink } from './parse-link.mjs';
import { createSession, fetchRechargeProducts } from './claro.mjs';
import { upsertNumber } from './numbers-db.mjs';

export function parseNumbersFromTxt(text) {
  const seen = new Set();
  const numbers = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const whole = normalizeBrMobile(trimmed);
    if (whole) {
      if (!seen.has(whole)) {
        seen.add(whole);
        numbers.push(whole);
      }
      continue;
    }
    for (const part of trimmed.split(/[,;]+/)) {
      const n = normalizeBrMobile(part);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      numbers.push(n);
    }
  }
  return numbers;
}

export function extractAvailableValues(productsBody) {
  const products = productsBody?.rechargeValues ?? [];
  return products
    .filter((p) => p.isAvailable !== false)
    .map((p) => ({
      id: p.id,
      name: p.name,
      value: p.value,
      validityDays: p.custom_attributes?.reload_validity,
    }));
}

export async function ingestMsisdn(msisdn) {
  const number = normalizeBrMobile(msisdn);
  if (!number) {
    throw new Error('Número inválido');
  }

  const generated = await fetchClaroLoginLink(number);
  const parsed = parseLink(generated.link);
  const session = await createSession(parsed.jwt);
  const products = await fetchRechargeProducts(session.id, session.identifier);
  if (!products.ok) {
    throw new Error(`Products HTTP ${products.status}`);
  }
  const valores = extractAvailableValues(products.body);
  const row = {
    msisdn: session.identifier || number,
    link: generated.link,
    valores,
    status: 'ok',
    error: null,
  };
  upsertNumber(row);
  return { ...row, sessionId: session.id };
}

async function mapPool(items, concurrency, worker) {
  let next = 0;
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        await worker(items[i], i);
      }
    }),
  );
}

export async function ingestNumbers(numbers, { concurrency = 5, onProgress } = {}) {
  const unique = [...new Set(numbers.map(normalizeBrMobile).filter(Boolean))];
  const results = [];
  let done = 0;
  let ok = 0;
  let fail = 0;

  await mapPool(unique, concurrency, async (msisdn) => {
    try {
      const row = await ingestMsisdn(msisdn);
      ok += 1;
      results.push(row);
    } catch (err) {
      fail += 1;
      const row = {
        msisdn,
        link: null,
        valores: [],
        status: 'error',
        error: String(err?.message || err),
      };
      upsertNumber(row);
      results.push(row);
    } finally {
      done += 1;
      onProgress?.({ done, total: unique.length, ok, fail });
    }
  });

  return { total: unique.length, ok, fail, results };
}
