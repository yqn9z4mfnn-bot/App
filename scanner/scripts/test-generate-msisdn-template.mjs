import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'num-tpl-'));
process.env.NUMBERS_DB = join(dir, 'numbers.db');

const { upsertNumber, listDistinctDdds, pickRandomStoredLogin } = await import('../lib/numbers-db.mjs');
const { generateMsisdnFromDb } = await import('../lib/generate-msisdn.mjs');

let failed = 0;
try {
  upsertNumber({
    msisdn: '11991004238',
    link: null,
    valores: [],
    status: 'sem_valor',
    error: null,
  });

  const ddds = listDistinctDdds();
  if (!ddds.includes('11')) {
    failed += 1;
    console.error('FAIL ddd sem link', ddds);
  }

  const generated = generateMsisdnFromDb();
  if (!/^1199100\d{4}$/.test(generated)) {
    failed += 1;
    console.error('FAIL template', generated);
  }

  upsertNumber({
    msisdn: '11991009999',
    link: 'https://clarorecarga.claro.com.br/minhaclaro_web/select-login?t=eyJtest',
    valores: [{ id: 'p1', name: 'R$20,00', value: 2000 }],
    status: 'ok',
  });
  const stored = pickRandomStoredLogin();
  if (!stored || stored.msisdn !== '11991009999' || !stored.link.includes('eyJtest')) {
    failed += 1;
    console.error('FAIL pickRandomStoredLogin', stored);
  }
  const excluded = pickRandomStoredLogin({ excludeMsisdns: ['11991009999'] });
  if (excluded) {
    failed += 1;
    console.error('FAIL exclude stored login', excluded);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error(`${failed} falha(s)`);
  process.exit(1);
}
console.log('ok generate template');
