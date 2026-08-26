#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { runScan } from './lib/run-scan.mjs';
import { printSummary } from './lib/report.mjs';

function usage() {
  console.log(`
Uso:
  node scan.mjs "<link ou JWT>"
  node scan.mjs "<link>" --out resultado.json
  node scan.mjs "<link>" --no-wallet   # pula Smart Checkout (evita 429)

Exemplos:
  node scan.mjs "https://clarorecarga.claro.com.br/minhaclaro_web/select-login?t=eyJ..."
  node scan.mjs "eyJhbGciOiJSUzI1NiIs..."
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    usage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const link = args.find((a) => !a.startsWith('-'));
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
  const skipWallet = args.includes('--no-wallet');
  const full = args.includes('--full');

  if (!link) {
    usage();
    process.exit(1);
  }

  return { link, outFile, skipWallet, full };
}

async function main() {
  const { link, outFile, skipWallet, full } = parseArgs(process.argv);

  const { summary, session, claro, wallet } = await runScan(link, { skipWallet, full });
  console.error(`[scan] sessão OK — ${session.identifier} (${session.segment})`);
  console.error(`[scan] API Claro — ${Object.keys(claro).length} endpoints`);

  printSummary(summary);

  const payload = {
    summary,
    raw: { session, claro, wallet },
  };

  if (outFile) {
    writeFileSync(outFile, JSON.stringify(payload, null, 2));
    console.error(`[scan] salvo em ${outFile}`);
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }
}

main().catch((err) => {
  console.error(`Erro: ${err.message}`);
  process.exit(1);
});
