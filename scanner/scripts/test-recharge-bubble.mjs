import {
  formatStatusBubble,
  formatRechargeResult,
  formatQueueFooter,
} from '../lib/recharge-format.mjs';

const destino = formatStatusBubble({
  title: 'Quem recebe?',
  valueLabel: 'R$ 35,00',
  login: '83993681996',
  hint: 'Envie o número destino (11 dígitos)',
});

const samples = [
  formatStatusBubble({ title: 'Preparando', hint: 'Gerando login…' }),
  destino,
  formatStatusBubble({
    title: 'Processando',
    valueLabel: 'R$ 35,00',
    cardMask: '****3490',
    login: '11991000330',
    target: '27996658547',
    hint: 'Aguardando checkout…',
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
      result: { status: 'DENIED', message: 'CREDIT_CARD - 422 - suspected fraud' },
      valueCents: 3000,
      cardMask: '****1111',
      loginMsisdn: '11991000330',
      targetMsisdn: '27996658547',
    },
    { footer: formatQueueFooter('consumed', 280) },
  ),
];

let failed = 0;

if (/blockquote/.test(destino)) {
  failed += 1;
  console.error('FAIL blockquote ainda presente');
}
if (/cartão/.test(destino)) {
  failed += 1;
  console.error('FAIL placeholder cartão no destino');
}
if (!destino.includes('<b>Quem recebe?</b>')) {
  failed += 1;
  console.error('FAIL titulo destino');
}
if (!destino.includes('<code>83993681996</code>')) {
  failed += 1;
  console.error('FAIL msisdn destino');
}

const deniedQueue = formatRechargeResult(
  {
    result: { status: 'DENIED', message: 'CREDIT_CARD - 422 - suspected fraud', negativeReason: 'CREDIT_CARD - 422 - suspected fraud' },
    valueCents: 3500,
    cardMask: '****8803',
    loginMsisdn: '11991001732',
    targetMsisdn: '62994111018',
  },
  { footer: formatQueueFooter('consumed', 257) },
);

if (!/Fraude suspeita/i.test(deniedQueue)) {
  failed += 1;
  console.error('FAIL motivo negada', deniedQueue);
}
if (!/Removido da fila · restam 257/.test(deniedQueue)) {
  failed += 1;
  console.error('FAIL fila negada', deniedQueue);
}

const denied = formatRechargeResult({
  result: { status: 'DENIED', message: 'CREDIT_CARD - 422 - suspected fraud' },
  valueCents: 3500,
  cardMask: '****1111',
  loginMsisdn: '11991000330',
  targetMsisdn: '27996658547',
});
if (!/Fraude suspeita/i.test(denied)) {
  failed += 1;
  console.error('FAIL motivo curto', denied);
}
if (/Edge fechado|Motivo:|Ref:/.test(denied)) {
  failed += 1;
  console.error('FAIL texto extra', denied);
}

for (const [i, text] of samples.entries()) {
  if (text.length > 900) {
    failed += 1;
    console.error('FAIL longo', i, text.length);
  }
}

if (failed) {
  console.error(`${failed} falha(s)`);
  process.exit(1);
}
console.log('ok', samples.length, 'mensagens');
console.log('--- destino ---');
console.log(destino);
