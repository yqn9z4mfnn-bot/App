import {
  isRechargeSuccess,
  isRecharge3ds,
  shouldOfferRechargeRetry,
  shouldScheduleAutoRetry,
  summarizeRechargeAttempt,
  formatAttemptLog,
  formatRechargeResult,
  MAX_AUTO_RECHARGE_RETRIES,
} from '../lib/recharge-format.mjs';

let failed = 0;
function check(name, cond, extra) {
  if (cond) return;
  failed += 1;
  console.error('FAIL', name, extra ?? '');
}

const success = { result: { status: 'CONFIRMED' } };
const denied = { result: { status: 'DENIED', message: 'CREDIT_CARD - 422 - suspected fraud' } };
const timeout = { result: { status: 'TIMEOUT', message: 'Timeout aguardando SSE HTTP' } };
const automationFail = { result: { status: 'AUTOMATION_FAIL', message: 'Formulário PAN não abriu' } };
const threeds = {
  result: {
    status: '3DS_REQUIRED',
    message: 'VBV/3DS visual — confirme manualmente no Edge',
    visualVbv: true,
    threeDsKind: 'cardinal',
  },
  automation: {
    raw: {
      status: '3ds_required',
      gateCode: '3DS',
      url: 'https://eldorado.m4u.com.br/bsc/checkout-link?x=1',
    },
  },
};
const checkoutErrorAs3ds = {
  result: {
    status: '3DS_REQUIRED',
    message: '3DS frictionless — aguardando confirmação automática',
    visualVbv: false,
    threeDsKind: 'challenge_api',
  },
  automation: {
    raw: {
      url: 'https://eldorado.m4u.com.br/bsc/checkout/error?code=abc',
      status: '3ds_required',
    },
  },
};
const checkoutSuccessAs3ds = {
  result: {
    status: '3DS_REQUIRED',
    message: '3DS frictionless — aguardando confirmação automática',
  },
  automation: {
    raw: {
      url: 'https://eldorado.m4u.com.br/bsc/checkout/success?code=abc',
      status: '3ds_required',
    },
  },
};

check('success', isRechargeSuccess(success));
check('success no retry', !shouldOfferRechargeRetry(success, null));
check('success no auto', !shouldScheduleAutoRetry({ outcome: success, pendingCards: 10 }));

check('3ds detect', isRecharge3ds(threeds));
check('3ds no retry', !shouldOfferRechargeRetry(threeds, null));
check('3ds no auto', !shouldScheduleAutoRetry({ outcome: threeds, pendingCards: 10 }));

check('checkout/error nao e 3ds', !isRecharge3ds(checkoutErrorAs3ds));
check('checkout/error oferece retry', shouldOfferRechargeRetry(checkoutErrorAs3ds, null));
check(
  'checkout/error auto',
  shouldScheduleAutoRetry({ outcome: checkoutErrorAs3ds, autoRetriesUsed: 0, pendingCards: 4 }),
);

check('checkout/success e aprovado', isRechargeSuccess(checkoutSuccessAs3ds));
check('checkout/success nao e 3ds', !isRecharge3ds(checkoutSuccessAs3ds));
check('checkout/success no retry', !shouldOfferRechargeRetry(checkoutSuccessAs3ds, null));

check('denied retry', shouldOfferRechargeRetry(denied, null));
check('timeout retry', shouldOfferRechargeRetry(timeout, null));
check('automation retry', shouldOfferRechargeRetry(automationFail, null));
check('throw retry', shouldOfferRechargeRetry(null, new Error('fetch failed')));

check(
  'auto 1/5',
  shouldScheduleAutoRetry({ outcome: denied, autoRetriesUsed: 0, pendingCards: 5 }),
);
check(
  'auto 4/5 ainda vai',
  shouldScheduleAutoRetry({ outcome: denied, autoRetriesUsed: 4, pendingCards: 5 }),
);
check(
  'auto esgotou na 5',
  !shouldScheduleAutoRetry({ outcome: denied, autoRetriesUsed: 5, pendingCards: 5 }),
);
check(
  'auto sem fila',
  !shouldScheduleAutoRetry({ outcome: denied, autoRetriesUsed: 0, pendingCards: 0 }),
);
check('teto padrao 5', MAX_AUTO_RECHARGE_RETRIES === 5, MAX_AUTO_RECHARGE_RETRIES);

const a1 = summarizeRechargeAttempt({
  outcome: {
    result: { status: 'AUTOMATION_FAIL', message: '12 - ERRO NO CARTAO' },
    cardMask: '****1951',
  },
  cardMask: '****1951',
});
const a2 = summarizeRechargeAttempt({
  outcome: { result: { status: 'DENIED', message: 'CREDIT_CARD - 422 - suspected fraud' } },
  cardMask: '****8803',
});
const a3 = summarizeRechargeAttempt({
  outcome: { result: { status: 'TIMEOUT', message: 'Timeout aguardando SSE HTTP' } },
  cardMask: '****3490',
});
check('resumo 1 tem 12', /12 - ERRO NO CARTAO/i.test(a1.reason), a1.reason);
const log = formatAttemptLog([a1, a2, a3]);
check('log 1', /1\) \*\*\*\*1951 · 12 - ERRO NO CARTAO/i.test(log), log);
check('log 2', /2\) \*\*\*\*8803 · Fraude suspeita/i.test(log), log);
check('log 3', /3\) \*\*\*\*3490 · Tempo esgotado/i.test(log), log);

const single = formatRechargeResult({
  result: { status: 'AUTOMATION_FAIL', message: '12 - ERRO NO CARTAO' },
  valueCents: 2000,
  cardMask: '****1951',
  loginMsisdn: '11992007768',
  targetMsisdn: '91987391356',
});
check('um erro nao numera', !/1\) \*\*\*\*1951/.test(single), single);
check('um erro mostra cartao', /<code>\*\*\*\*1951<\/code>/.test(single), single);

const triple = formatRechargeResult(
  {
    result: { status: 'AUTOMATION_FAIL', message: '12 - ERRO NO CARTAO' },
    valueCents: 2000,
    cardMask: '****3490',
    loginMsisdn: '11992007768',
    targetMsisdn: '91987391356',
  },
  { footer: 'Voltou pra fila · 2209 pendente(s)', attempts: [a1, a2, a3] },
);
check('tres erros na bolha', /1\) \*\*\*\*1951/.test(triple) && /2\) \*\*\*\*8803/.test(triple) && /3\) \*\*\*\*3490/.test(triple), triple);
check('tres erros esconde cartao unico', !/<code>\*\*\*\*3490<\/code>/.test(triple), triple);
check('tres erros mantem fila', /Voltou pra fila · 2209/.test(triple), triple);

const seven = [
  a1, a2, a3,
  summarizeRechargeAttempt({ outcome: denied, cardMask: '****1616' }),
  summarizeRechargeAttempt({ outcome: denied, cardMask: '****9683' }),
  summarizeRechargeAttempt({ outcome: timeout, cardMask: '****1434' }),
  summarizeRechargeAttempt({ outcome: automationFail, cardMask: '****6913' }),
];
const capped = formatRechargeResult(
  {
    result: { status: 'AUTOMATION_FAIL', message: '12 - ERRO NO CARTAO' },
    valueCents: 2000,
    cardMask: '****6913',
    loginMsisdn: '11992005797',
    targetMsisdn: '91987572274',
  },
  { footer: 'Voltou pra fila · 2175 pendente(s)', attempts: seven },
);
check('nao lista 7 erros', !/6\)/.test(capped) && !/\*\*\*\*1951/.test(capped), capped);
check('so os 5 ultimos', /1\) \*\*\*\*3490/.test(capped) && /5\) \*\*\*\*6913/.test(capped), capped);

const approvedAfterFails = formatRechargeResult(
  {
    result: { status: 'CONFIRMED' },
    valueCents: 2000,
    cardMask: '****8383',
    loginMsisdn: '11992000282',
    targetMsisdn: '91987391356',
    latencyMs: 25000,
  },
  {
    footer: 'Aprovado · fila 2207',
    attempts: [
      a1,
      summarizeRechargeAttempt({
        outcome: { result: { status: 'CONFIRMED' }, latencyMs: 25000 },
        cardMask: '****8383',
      }),
    ],
  },
);
check('aprovada sem historico', !/1\) \*\*\*\*1951/.test(approvedAfterFails), approvedAfterFails);
check('aprovada sem footer fila', !/Aprovado · fila/.test(approvedAfterFails), approvedAfterFails);
check('aprovada titulo', /✅ APROVADA/.test(approvedAfterFails), approvedAfterFails);
check('aprovada tempo', /Confirmada em 25s/.test(approvedAfterFails), approvedAfterFails);
check('aprovada mostra cartao', /\*\*\*\*8383/.test(approvedAfterFails), approvedAfterFails);

if (failed) {
  console.error(`${failed} falha(s)`);
  process.exit(1);
}
console.log('ok auto-retry');
