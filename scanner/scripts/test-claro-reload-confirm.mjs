import {
  findMatchingReload,
  isClaroReloadNok,
  isClaroReloadOk,
  applyClaroNokToOutcome,
  shouldDenyOnClaroNok,
  CLARO_NOK_MESSAGE,
} from '../lib/claro-reload-confirm.mjs';
import { isRechargeSuccess } from '../lib/recharge-format.mjs';
import { classifyCardListAction } from '../lib/card-outcome.mjs';

let failed = 0;
function check(name, cond, extra) {
  if (cond) return;
  failed += 1;
  console.error('FAIL', name, extra ?? '');
}

const items = [
  {
    targetMsisdn: '53992033406',
    registerDate: '2026-08-31T01:28:35.000Z',
    status: 'nok',
    paymentMethod: { source: { params: { last: '2994' } } },
    rechargeValue: { value: 3000 },
  },
];

const hit = findMatchingReload(items, {
  targetMsisdn: '53992033406',
  last4: '2994',
  sinceMs: Date.parse('2026-08-31T01:28:00.000Z'),
});
check('acha nok', hit?.status === 'nok', hit);
check('é nok', isClaroReloadNok(hit));
check('não é ok', isClaroReloadOk(hit) === false);

const confirmed = {
  result: { status: 'CONFIRMED', message: 'Pagamento confirmado', gateCode: 'CONFIRMED' },
  automation: { raw: { status: 'success', gateCode: 'CONFIRMED', url: 'https://eldorado.m4u.com.br/bsc/checkout?code=abc' } },
};
check('antes success', isRechargeSuccess(confirmed));
check('antes approved', classifyCardListAction({ outcome: confirmed }) === 'approved');

check('gate confirmado não nega', shouldDenyOnClaroNok(confirmed) === false);

const flipped = applyClaroNokToOutcome(confirmed, { status: 'nok' });
check('mantém success', isRechargeSuccess(flipped) === true);
check('aviso claro', flipped.claroConfirmWarning === CLARO_NOK_MESSAGE);
check('fila approved', classifyCardListAction({ outcome: flipped }) === 'approved');

const pending = { result: { status: 'PENDING' }, automation: { raw: { status: 'pending' } } };
const denied = applyClaroNokToOutcome(pending, { status: 'nok' });
check('sem gate vira denied', denied.result.status === 'DENIED');

if (failed) {
  console.error(`${failed} falha(s)`);
  process.exit(1);
}
console.log('ok claro-reload-confirm');
