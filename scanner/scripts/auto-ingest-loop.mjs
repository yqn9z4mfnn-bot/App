#!/usr/bin/env node
/**
 * Gera N números únicos por lote (prefixo do banco + 4 dígitos),
 * consulta 1 por vez, grava link + valores no numbers.db, pausa e repete.
 *
 * Uso:
 *   node scripts/auto-ingest-loop.mjs
 *   AUTO_INGEST_BATCH=1000 AUTO_INGEST_PAUSE_MS=7200000 node scripts/auto-ingest-loop.mjs
 */
import '../lib/load-env.mjs';
import { generateUniqueMsisdnsFromPrefixes } from '../lib/generate-msisdn.mjs';
import { ingestNumbers } from '../lib/bulk-scan.mjs';
import { listAllMsisdns, listLoginPrefixes, countNumbers } from '../lib/numbers-db.mjs';

const BATCH = Math.max(1, Number(process.env.AUTO_INGEST_BATCH || 1000));
const PAUSE_MS = Math.max(60_000, Number(process.env.AUTO_INGEST_PAUSE_MS || 2 * 60 * 60 * 1000));
const CONCURRENCY = Math.max(1, Number(process.env.AUTO_INGEST_CONCURRENCY || 1));
const LOG_EVERY = Math.max(1, Number(process.env.AUTO_INGEST_LOG_EVERY || 10));

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatPause(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h ? `${h}h${m ? `${m}m` : ''}` : `${m}m`;
}

async function runBatch(batchNo) {
  const prefixes = listLoginPrefixes();
  if (!prefixes.length) {
    throw new Error('Banco sem prefixos (DDD+5) — envie um .txt com números primeiro');
  }

  const existing = listAllMsisdns();
  log(
    `lote #${batchNo} · banco=${existing.size} · prefixos=${prefixes.length} · gerar=${BATCH} · conc=${CONCURRENCY}`,
  );

  const numbers = generateUniqueMsisdnsFromPrefixes(BATCH, { existing, prefixes });
  log(`lote #${batchNo} · ${numbers.length} MSISDNs novos (amostra ${numbers.slice(0, 3).join(', ')})`);

  const t0 = Date.now();
  const result = await ingestNumbers(numbers, {
    concurrency: CONCURRENCY,
    skipOk: true,
    onProgress: (p) => {
      if (p.done === 0 || p.done % LOG_EVERY === 0 || p.done === p.total) {
        const sec = Math.max(1, Math.round((Date.now() - t0) / 1000));
        log(
          `lote #${batchNo} · ${p.done}/${p.total} · ok=${p.ok} fail=${p.fail}${p.skipped ? ` skip=${p.skipped}` : ''} · ${sec}s`,
        );
      }
    },
  });

  const elapsed = Math.max(1, Math.round((Date.now() - t0) / 1000));
  log(
    `lote #${batchNo} fim · total=${result.total} ok=${result.ok} fail=${result.fail} skip=${result.skipped} · ${elapsed}s · banco=${countNumbers({ onlyOk: false })}`,
  );
  return result;
}

log(`auto-ingest-loop · batch=${BATCH} pause=${formatPause(PAUSE_MS)} conc=${CONCURRENCY}`);

let batchNo = 0;
while (true) {
  batchNo += 1;
  try {
    await runBatch(batchNo);
  } catch (err) {
    log(`lote #${batchNo} ERRO: ${err?.message || err}`);
  }

  const resumeAt = new Date(Date.now() + PAUSE_MS).toISOString();
  log(`pausa ${formatPause(PAUSE_MS)} · próximo lote ~${resumeAt}`);
  await sleep(PAUSE_MS);
}
