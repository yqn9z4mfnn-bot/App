import { parseQuickCrossRecharge } from '../lib/quick-cross-recharge.mjs';
import { parseCardInput } from '../lib/card-parse.mjs';

const cases = [
  ['13991019331|Claro|30', { targetMsisdn: '13991019331', valueCents: 3000 }],
  ['(13) 99101-9331 | claro | R$30', { targetMsisdn: '13991019331', valueCents: 3000 }],
  ['13991019331;CLARO;15,00', { targetMsisdn: '13991019331', valueCents: 1500 }],
  ['13991019331|Vivo|30', null],
  ['4271680002723941|08|2033|999', null],
  ['13991019331|Claro', null],
  ['30', null],
];

let failed = 0;
for (const [input, expected] of cases) {
  const got = parseQuickCrossRecharge(input);
  const ok = expected
    ? got?.targetMsisdn === expected.targetMsisdn && got?.valueCents === expected.valueCents
    : got == null;
  if (!ok) {
    failed += 1;
    console.error('FAIL', JSON.stringify({ input, expected, got }));
  }
}

if (parseCardInput('13991019331|Claro|30')) {
  failed += 1;
  console.error('FAIL atalho não pode ser cartão');
}

if (failed) {
  console.error(`${failed} falha(s)`);
  process.exit(1);
}
console.log('ok', cases.length, 'casos');
