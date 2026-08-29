import {
  BUBBLE_LINES,
  formatStatusBubble,
  formatRechargeResult,
  formatQueueFooter,
} from '../lib/recharge-format.mjs';

function countLines(text) {
  return String(text).split('\n').length;
}

const samples = [
  formatStatusBubble({}),
  formatStatusBubble({
    title: 'Recarga',
    valueLabel: 'R$ 35,00',
    cardMask: '****3490',
    login: '11991000330',
    target: '27996658547',
    status: '⏳ Processando…',
    footer: '—',
  }),
  formatRechargeResult({
    result: { status: 'CONFIRMED' },
    valueCents: 3500,
    cardMask: '****3490',
    loginMsisdn: '11991000330',
    targetMsisdn: '27996658547',
    latencyMs: 42000,
  }),
  formatRechargeResult(
    {
      result: {
        status: 'DENIED',
        message: 'CREDIT_CARD - 422 - suspected fraud',
      },
      valueCents: 3000,
      cardMask: '****1111',
      loginMsisdn: '11991000330',
      targetMsisdn: '11991000330',
    },
    { footer: formatQueueFooter('consumed', 280) },
  ),
  formatRechargeResult({
    result: {
      status: '3DS_REQUIRED',
      visualVbv: true,
      threeDsHint: 'uma tela enorme de banco que antes esticava a bolha do telegram',
    },
    valueCents: 2000,
    cardMask: '****2222',
    loginMsisdn: '11991000330',
    targetMsisdn: '85992273695',
  }),
];

let failed = 0;
for (const [i, text] of samples.entries()) {
  const n = countLines(text);
  if (n !== BUBBLE_LINES) {
    failed += 1;
    console.error('FAIL lines', i, n, text);
  }
}

const denied = formatRechargeResult({
  result: { status: 'DENIED', message: 'CREDIT_CARD - 422 - suspected fraud' },
  valueCents: 3000,
  cardMask: '****1111',
  loginMsisdn: '11',
  targetMsisdn: '11',
});
if (!denied.includes('fraude suspeita')) {
  failed += 1;
  console.error('FAIL short reason', denied);
}
if (/Edge fechado|Motivo:|Ref:/.test(denied)) {
  failed += 1;
  console.error('FAIL extra text', denied);
}

if (failed) {
  console.error(`${failed} falha(s)`);
  process.exit(1);
}
console.log('ok', samples.length, 'bolhas ·', BUBBLE_LINES, 'linhas');
