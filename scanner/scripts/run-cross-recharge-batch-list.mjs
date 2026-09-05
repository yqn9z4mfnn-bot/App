#!/usr/bin/env node
/**
 * Lista de recargas cruzadas — executa run-cross-recharge-until.mjs para cada linha.
 * Uso: node scripts/run-cross-recharge-batch-list.mjs [max_tentativas_por_destino]
 *
 * Linhas no stdin ou embutidas: DESTINO|CLARO|VALOR_REAIS
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const maxPerTarget = Math.min(50, Math.max(1, Number(process.argv[2] ?? 10) || 10));
const scriptDir = dirname(fileURLToPath(import.meta.url));
const untilScript = join(scriptDir, 'run-cross-recharge-until.mjs');

const DEFAULT_LINES = `
73981024172|CLARO|20
79999910284|CLARO|35
81992189125|CLARO|30
86994612832|Claro|25
71984230254|CLARO|20
71984198055|Claro|20
91984828575|CLARO|20
91984197844|Claro|30
`.trim();

function parseLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const parts = line.split(/[|;]+/).map((p) => p.trim());
      if (parts.length < 3) throw new Error(`Linha inválida: ${line}`);
      const target = parts[0].replace(/\D/g, '');
      const value = parts[2].replace(/\D/g, '');
      if (target.length !== 11 || !value) throw new Error(`Linha inválida: ${line}`);
      return { target, value, raw: line };
    });
}

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text || null;
}

function runUntil(target, value) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [untilScript, target, value, String(maxPerTarget)], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const stdinText = await readStdin();
const jobs = parseLines(stdinText ?? DEFAULT_LINES);

console.log(`=== batch ${jobs.length} destinos · max ${maxPerTarget} tentativas cada ===\n`);

const summary = [];
for (let i = 0; i < jobs.length; i++) {
  const { target, value, raw } = jobs[i];
  console.log(`\n--- [${i + 1}/${jobs.length}] ${raw} ---\n`);
  const code = await runUntil(target, value);
  summary.push({ target, value, code, ok: code === 0 });
  if (code === 0) {
    console.log(`\n✅ Destino ${target} R$${value} aprovado\n`);
  } else {
    console.log(`\n❌ Destino ${target} R$${value} encerrou com código ${code}\n`);
  }
}

console.log('\n=== RESUMO ===');
for (const row of summary) {
  console.log(`${row.ok ? '✅' : '❌'} ${row.target} R$${row.value} (exit ${row.code})`);
}

process.exit(summary.every((r) => r.ok) ? 0 : 1);
