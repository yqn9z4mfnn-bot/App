#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { parseLink } from './lib/parse-link.mjs';
import { createSession, scanClaroApi } from './lib/claro.mjs';
import { scanWallet } from './lib/eldorado.mjs';
import { buildSummary, printSummary } from './lib/report.mjs';

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

  if (!link) {
    usage();
    process.exit(1);
  }

  return { link, outFile, skipWallet };
}

async function main() {
  const started = Date.now();
  const { link, outFile, skipWallet } = parseArgs(process.argv);

  const parsed = parseLink(link);
  let session;
  let wallet = null;

  if (parsed.kind === 'jwt') {
    session = await createSession(parsed.jwt);
  } else {
    throw new Error(
      'Modo checkout-only ainda não suportado — use link select-login com ?t=JWT',
    );
  }

  const msisdn = session.identifier;
  console.error(`[scan] sessão OK — ${msisdn} (${session.segment})`);

  const claro = await scanClaroApi(session.id, msisdn);
  console.error(`[scan] API Claro — ${Object.keys(claro).length} endpoints`);

  const products = claro.products?.body?.rechargeValues ?? [];
  const firstProduct =
    products.find((p) => p.isAvailable !== false) ?? products[0];

  if (!skipWallet && firstProduct?.id) {
    console.error('[scan] wallet Eldorado…');
    try {
      wallet = await scanWallet(session.id, msisdn, firstProduct.id);
      if (wallet.error) {
        console.error(`[scan] wallet: ${wallet.message}`);
      }
    } catch (err) {
      wallet = {
        error: 'wallet_exception',
        message: err.message,
        walletCards: null,
      };
      console.error(`[scan] wallet: ${err.message}`);
    }
  }

  const summary = buildSummary({ session, claro, wallet, skipWallet });
  summary.meta = {
    latencyMs: Date.now() - started,
    sessionId: `${session.id.slice(0, 8)}…`,
  };

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
