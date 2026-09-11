#!/usr/bin/env node
/**
 * Gera N números (prefixo do banco + 4 dígitos), consulta 2 por vez e grava no DB.
 * Uso: node scripts/generate-5k-from-prefixes.mjs [--count 5000] [--concurrency 2]
 */
import '../lib/load-env.mjs';
import { generateUniqueMsisdnsFromPrefixes } from '../lib/generate-msisdn.mjs';
import { ingestNumbers } from '../lib/bulk-scan.mjs';
import { listAllMsisdns, listLoginPrefixes, countNumbers } from '../lib/numbers-db.mjs';

function argNum(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : fallback;
}
const count = argNum('--count', 5000);
const concurrency = Math.max(1, argNum('--concurrency', 2));

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

const prefixes = listLoginPrefixes();
const existing = listAllMsisdns();
log(`banco=${existing.size} prefixos=${prefixes.length} gerar=${count} conc=${concurrency}`);
if (!prefixes.length) {
  throw new Error('Sem prefixos no banco');
}

const numbers = generateUniqueMsisdnsFromPrefixes(count, { existing, prefixes });
log(`gerados ${numbers.length} únicos (amostra ${numbers.slice(0, 3).join(', ')})`);

const t0 = Date.now();
const result = await ingestNumbers(numbers, {
  concurrency,
  skipOk: true,
  onProgress: (p) => {
    if (p.done === 0 || p.done % 25 === 0 || p.done === p.total) {
      const sec = Math.max(1, Math.round((Date.now() - t0) / 1000));
      log(`${p.done}/${p.total} ✅${p.ok} ❌${p.fail} ${sec}s`);
    }
  },
});

log(
  `fim arquivo=${result.total} ok=${result.ok} fail=${result.fail} skip=${result.skipped} banco=${countNumbers({ onlyOk: false })}`,
);
