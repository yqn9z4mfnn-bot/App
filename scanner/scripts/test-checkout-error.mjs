import {
  checkoutErrorHint,
  isCheckoutErrorUrl,
  isCheckoutErrorText,
  looksLikeCheckoutError,
  overrideThreedsIfCheckoutError,
} from '../lib/checkout-error.mjs';
import { mapAutomationPaymentStatus } from '../lib/automation-client.mjs';
import { classifyCardListAction } from '../lib/card-outcome.mjs';
import { formatRechargeResult } from '../lib/recharge-format.mjs';
import { buildPaymentResultFromHttpSse } from '../automation/gate.mjs';

const INCIDENT_URL =
  'https://eldorado.m4u.com.br/bsc/checkout/error?code=b4dcbde2-16fc-48f2-904c-19a386b72a1f';
const INCIDENT_TEXT =
  'Não foi possível concluir o seu pagamento Infelizmente não conseguimos realizar o seu pagamento. Tente novamente mais tarde.';

let failed = 0;
function check(name, cond, extra = '') {
  if (!cond) {
    failed += 1;
    console.error('FAIL', name, extra);
  }
}

check('url checkout/error', isCheckoutErrorUrl(INCIDENT_URL));
check('url pagamento-erro', isCheckoutErrorUrl('https://clarorecarga.claro.com.br/whatsapp/pagamento-erro'));
check('url checkout-link nao e erro', !isCheckoutErrorUrl('https://eldorado.m4u.com.br/bsc/checkout-link?x=1'));
check('texto concluir', isCheckoutErrorText(INCIDENT_TEXT));
check('texto realizar', isCheckoutErrorText('Infelizmente não conseguimos realizar o seu pagamento'));
check('texto 3DS nao e erro', !isCheckoutErrorText('3DS frictionless — aguardando confirmação automática'));
check(
  'looksLike url',
  looksLikeCheckoutError({ url: INCIDENT_URL, message: '3DS frictionless — aguardando confirmação automática' }),
);
check('hint', /Não foi possível concluir/i.test(checkoutErrorHint(INCIDENT_TEXT)));

const overridden = overrideThreedsIfCheckoutError(
  {
    status: '3ds_required',
    url: INCIDENT_URL,
    gateCode: '3DS',
    gateMessage: '3DS frictionless — aguardando confirmação automática',
    message: '3DS frictionless — aguardando confirmação automática',
    visualVbv: false,
    pagamentoErro: false,
  },
  { url: INCIDENT_URL, text: INCIDENT_TEXT },
);
check('override status', overridden.status === 'error', overridden.status);
check('override nao 3DS', overridden.gateCode !== '3DS', overridden.gateCode);
check('override hint', /concluir/i.test(overridden.gateMessage || ''), overridden.gateMessage);
check('override visualVbv', overridden.visualVbv === false);

const mapped = mapAutomationPaymentStatus(
  {
    status: '3ds_required',
    gateCode: '3DS',
    gateMessage: '3DS frictionless — aguardando confirmação automática',
    url: INCIDENT_URL,
  },
  {},
);
check('map 3ds+error url → DENIED', mapped === 'DENIED', mapped);

const mappedText = mapAutomationPaymentStatus(
  {
    status: 'error',
    gateMessage: INCIDENT_TEXT,
    url: 'https://eldorado.m4u.com.br/bsc/checkout-link',
  },
  {},
);
check('map error text → DENIED', mappedText === 'DENIED', mappedText);

const keep3ds = mapAutomationPaymentStatus(
  {
    status: '3ds_required',
    gateCode: '3DS',
    gateMessage: 'VBV/3DS visual — confirme manualmente no Edge',
    url: 'https://eldorado.m4u.com.br/bsc/checkout-link?x=1',
  },
  {},
);
check('map 3ds real permanece', keep3ds === '3DS_REQUIRED', keep3ds);

const classified = classifyCardListAction({
  outcome: {
    result: { status: 'DENIED', message: INCIDENT_TEXT },
    automation: { raw: { status: 'error', gateMessage: INCIDENT_TEXT } },
  },
});
check('classify checkout error consome', classified === 'consumed', classified);

const bubbleFromUrl = formatRechargeResult({
  result: {
    status: '3DS_REQUIRED',
    message: '3DS frictionless — aguardando confirmação automática',
    visualVbv: false,
    threeDsKind: 'challenge_api',
  },
  valueCents: 3000,
  cardMask: '****1861',
  loginMsisdn: '11992007057',
  targetMsisdn: '61995063971',
  automation: { raw: { url: INCIDENT_URL, status: '3ds_required' } },
});
check('bolha titulo negada', /Recarga negada/.test(bubbleFromUrl), bubbleFromUrl);
check('bolha nao diz VBV', !/3DS visual|Validação 3DS|Confirme no banco/i.test(bubbleFromUrl), bubbleFromUrl);
check('bolha motivo real', /Não foi possível concluir o pagamento/.test(bubbleFromUrl), bubbleFromUrl);

const bubbleFromText = formatRechargeResult({
  result: {
    status: 'DENIED',
    message: INCIDENT_TEXT,
    negativeReason: INCIDENT_TEXT,
  },
  valueCents: 3000,
  cardMask: '****1861',
  loginMsisdn: '11992007057',
  targetMsisdn: '61995063971',
});
check('bolha texto checkout', /Não foi possível concluir o pagamento/.test(bubbleFromText), bubbleFromText);

const sseError = buildPaymentResultFromHttpSse(
  { status: 'PENDING' },
  INCIDENT_URL,
  'pay-1',
  { had3ds: true },
);
check('http sse checkout/error nao e 3DS', sseError.status === 'error', sseError.status);
check('http sse hint', /concluir/i.test(sseError.gateMessage || ''), sseError.gateMessage);

const sse3ds = buildPaymentResultFromHttpSse(
  { status: 'PENDING' },
  'https://eldorado.m4u.com.br/bsc/checkout-link',
  'pay-2',
  { had3ds: true },
);
check('http sse 3DS real', sse3ds.status === '3ds_required', sse3ds.status);

if (failed) {
  console.error(`${failed} falha(s)`);
  process.exit(1);
}
console.log('ok checkout-error');
console.log('--- bolha incidente ---');
console.log(bubbleFromUrl);
