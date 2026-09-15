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
import { listAllMsisdns, listLoginPrefixes, countNumbers, countWithValues } from '../lib/numbers-db.mjs';
import { resolveNotifyChatIds, sendTelegramNotify } from '../lib/telegram-notify.mjs';

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

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h${m}m`;
  if (m) return `${m}m${s}s`;
  return `${s}s`;
}

function brTime(iso) {
  try {
    return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  } catch {
    return iso;
  }
}

async function notifyCycleEnd({ batchNo, result, elapsedSec, error = null }) {
  const resumeAt = new Date(Date.now() + PAUSE_MS);
  const dbTotal = countNumbers({ onlyOk: false });
  const dbValores = countWithValues();
  const lines = [
    error ? '<b>⚠️ Auto-ingest — lote com erro</b>' : '<b>✅ Auto-ingest — lote concluído</b>',
    '',
    `Lote: <b>#${batchNo}</b>`,
  ];

  if (result) {
    lines.push(
      `Processados: <b>${result.total}</b>`,
      `✅ OK: <b>${result.ok}</b>   ❌ Erros: <b>${result.fail}</b>${result.skipped ? `   ⏭ Skip: <b>${result.skipped}</b>` : ''}`,
    );
  }
  if (error) {
    lines.push('', `Erro: <code>${String(error).replace(/</g, '&lt;').slice(0, 200)}</code>`);
  }

  lines.push(
    '',
    `Duração: <b>${formatDuration(elapsedSec)}</b>`,
    `Banco: <b>${dbTotal}</b> números · <b>${dbValores}</b> com valores`,
    '',
    `Pausa: <b>${formatPause(PAUSE_MS)}</b>`,
    `Próximo lote: <b>${brTime(resumeAt.toISOString())}</b> (BRT)`,
  );

  const sent = await sendTelegramNotify(lines.join('\n'));
  if (sent) log(`notificação Telegram enviada (lote #${batchNo})`);
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

const notifyChats = resolveNotifyChatIds();
log(
  `auto-ingest-loop · batch=${BATCH} pause=${formatPause(PAUSE_MS)} conc=${CONCURRENCY} notify=${notifyChats.length ? notifyChats.join(',') : 'off'}`,
);

let batchNo = 0;
while (true) {
  batchNo += 1;
  const tBatch = Date.now();
  let result = null;
  let batchError = null;
  try {
    result = await runBatch(batchNo);
  } catch (err) {
    batchError = err?.message || String(err);
    log(`lote #${batchNo} ERRO: ${batchError}`);
  }

  const elapsedSec = Math.max(1, Math.round((Date.now() - tBatch) / 1000));
  await notifyCycleEnd({ batchNo, result, elapsedSec, error: batchError });

  const resumeAt = new Date(Date.now() + PAUSE_MS).toISOString();
  log(`pausa ${formatPause(PAUSE_MS)} · próximo lote ~${resumeAt}`);
  await sleep(PAUSE_MS);
}
