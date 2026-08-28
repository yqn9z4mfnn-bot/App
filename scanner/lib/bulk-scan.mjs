import { fetchClaroLoginLink, normalizeBrMobile } from './fetch-claro-link.mjs';
import { parseLink } from './parse-link.mjs';
import { createSession, fetchRechargeProducts } from './claro.mjs';
import { upsertNumber, listOkMsisdns, getNumber } from './numbers-db.mjs';

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
    .filter((p) => p.isAvailable === true)
    .map((p) => ({
      id: p.id,
      name: p.name,
      value: p.value,
      validityDays: p.custom_attributes?.reload_validity,
    }));
}

export function countListedProducts(productsBody) {
  return (productsBody?.rechargeValues ?? []).length;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  return /429|Too Many|Timeout|fetch failed|ECONNRESET|UND_ERR|socket/i.test(
    String(err?.message || err),
  );
}

export async function ingestMsisdn(msisdn) {
  const number = normalizeBrMobile(msisdn);
  if (!number) {
    throw new Error('Número inválido');
  }

  const generated = await fetchClaroLoginLink(number, { timeoutMs: 12_000 });
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
    status: valores.length ? 'ok' : 'sem_valor',
    error: null,
  };
  upsertNumber(row);
  return { ...row, sessionId: session.id };
}

/** Atualiza valores no banco consultando /products ao vivo. */
export async function refreshMsisdnProducts(msisdn, { link = null, sessionId = null, identifier = null } = {}) {
  const number = normalizeBrMobile(msisdn);
  if (!number) throw new Error('Número inválido');

  let loginLink = link;
  let session = sessionId && identifier ? { id: sessionId, identifier } : null;

  if (!session) {
    const saved = getNumber(number);
    loginLink = loginLink || saved?.link;
    if (loginLink) {
      session = await createSession(parseLink(loginLink).jwt);
    } else {
      const generated = await fetchClaroLoginLink(number, { timeoutMs: 12_000 });
      loginLink = generated.link;
      session = await createSession(parseLink(generated.link).jwt);
    }
  }

  const products = await fetchRechargeProducts(session.id, session.identifier);
  if (!products.ok) {
    throw new Error(`Products HTTP ${products.status}`);
  }

  const valores = extractAvailableValues(products.body);
  const listed = countListedProducts(products.body);
  const row = {
    msisdn: session.identifier || number,
    link: loginLink,
    valores,
    status: valores.length ? 'ok' : 'sem_valor',
    error: null,
  };
  upsertNumber(row);
  return {
    ...row,
    sessionId: session.id,
    listedProducts: listed,
  };
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

export async function ingestNumbers(numbers, { concurrency = 1, skipOk = true, onProgress } = {}) {
  const unique = [...new Set(numbers.map(normalizeBrMobile).filter(Boolean))];
  const already = skipOk ? listOkMsisdns() : new Set();
  const pending = unique.filter((n) => !already.has(n));
  const skipped = unique.length - pending.length;

  const results = [];
  let done = 0;
  let ok = 0;
  let fail = 0;
  let pauseUntil = 0;

  const emit = () =>
    onProgress?.({
      done,
      total: pending.length,
      queued: unique.length,
      skipped,
      ok,
      fail,
    });

  emit();

  await mapPool(pending, concurrency, async (msisdn) => {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = pauseUntil - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        const row = await ingestMsisdn(msisdn);
        ok += 1;
        results.push(row);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === 3) break;
        const msg = String(err?.message || err);
        const backoff = /429|Too Many/.test(msg)
          ? Math.min(2500 * 2 ** attempt, 12_000)
          : 800 * (attempt + 1);
        pauseUntil = Math.max(pauseUntil, Date.now() + backoff);
        await sleep(backoff);
      }
    }

    if (lastErr) {
      fail += 1;
      const row = {
        msisdn,
        link: null,
        valores: [],
        status: 'error',
        error: String(lastErr?.message || lastErr),
      };
      upsertNumber(row);
      results.push(row);
    }

    done += 1;
    emit();
  });

  return { total: unique.length, pending: pending.length, skipped, ok, fail, results };
}
