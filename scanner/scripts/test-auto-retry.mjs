import {
  isRechargeSuccess,
  isRecharge3ds,
  shouldOfferRechargeRetry,
  shouldScheduleAutoRetry,
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
  'auto 1/3',
  shouldScheduleAutoRetry({ outcome: denied, autoRetriesUsed: 0, pendingCards: 5 }),
);
check(
  'auto 3/3 ainda vai',
  shouldScheduleAutoRetry({ outcome: denied, autoRetriesUsed: 2, pendingCards: 5 }),
);
check(
  'auto esgotou',
  !shouldScheduleAutoRetry({ outcome: denied, autoRetriesUsed: 3, pendingCards: 5 }),
);
check(
  'auto sem fila',
  !shouldScheduleAutoRetry({ outcome: denied, autoRetriesUsed: 0, pendingCards: 0 }),
);
check('teto padrao 3', MAX_AUTO_RECHARGE_RETRIES === 3, MAX_AUTO_RECHARGE_RETRIES);

if (failed) {
  console.error(`${failed} falha(s)`);
  process.exit(1);
}
console.log('ok auto-retry');
