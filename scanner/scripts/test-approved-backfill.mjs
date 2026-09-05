import { parseApprovedLine } from '../lib/approved-backfill.mjs';

const line =
  '4111111111111111|12|2030|123 # 2026-08-28 23:11:05 R$20,00 11991001819->65993534703 SUCCESS';
const got = parseApprovedLine(line);
const expect = {
  last4: '1111',
  productName: 'R$20,00',
  productValueCents: 2000,
  loginMsisdn: '11991001819',
  targetMsisdn: '65993534703',
  createdAt: Date.parse('2026-08-28T23:11:05Z'),
  ok: true,
};

let failed = 0;
for (const [k, v] of Object.entries(expect)) {
  if (got?.[k] !== v) {
    failed += 1;
    console.error('FAIL', k, { expected: v, got: got?.[k] });
  }
}

if (parseApprovedLine('4111111111111111|12|2030|123')?.ok) {
  failed += 1;
  console.error('FAIL linha sem meta não é ok');
}

if (parseApprovedLine('# comentario')) {
  failed += 1;
  console.error('FAIL comentario');
}

if (failed) {
  console.error(`${failed} falha(s)`);
  process.exit(1);
}
console.log('ok parseApprovedLine');
