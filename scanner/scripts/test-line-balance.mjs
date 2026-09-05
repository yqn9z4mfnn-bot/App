import {
  parseBalanceBody,
  formatBalanceLine,
  formatBalanceCompare,
  formatValidityDate,
  balancesChanged,
  AFTER_BALANCE_POLL_MS,
} from '../lib/line-balance.mjs';
import { formatRechargeResult } from '../lib/recharge-format.mjs';
import { buildSummary } from '../lib/report.mjs';
import { formatTelegramReport } from '../lib/telegram-format.mjs';

let failed = 0;
function check(name, cond, extra) {
  if (cond) return;
  failed += 1;
  console.error('FAIL', name, extra ?? '');
}

const parsed = parseBalanceBody({
  value: 110,
  total: 110,
  expiration_date: '2026-09-22',
  bonus: [],
});
check('parse cents', parsed?.cents === 110, parsed);
check('parse val', parsed?.expiration === '2026-09-22', parsed);
check('data br', formatValidityDate('2026-09-22') === '22/09/2026');
check('linha', formatBalanceLine(parsed) === 'R$ 1,10 · val. 22/09/2026', formatBalanceLine(parsed));

const after = parseBalanceBody({
  value: 2110,
  total: 2110,
  expiration_date: '2026-10-22',
  bonus: [],
});
const cmp = formatBalanceCompare(parsed, after);
check('antes', /Antes: R\$ 1,10 · val\. 22\/09\/2026/.test(cmp), cmp);
check('depois', /Depois: R\$ 21,10 · val\. 22\/10\/2026/.test(cmp), cmp);
check('delta', /Δ \+R\$ 20,00/.test(cmp), cmp);
check('validade mudou', /22\/09\/2026 → 22\/10\/2026/.test(cmp), cmp);

const same = formatBalanceCompare(parsed, parsed);
check('igual nao afirma que nao caiu', !/Saldo não mudou/.test(same), same);
check('igual avisa atraso', /API ainda não atualizou/.test(same), same);
check('mudou valor', balancesChanged(parsed, after) === true);
check('igual nao mudou', balancesChanged(parsed, parsed) === false);
check(
  'mudou validade',
  balancesChanged(parsed, { ...parsed, expiration: '2026-11-28' }) === true,
);
check('poll tem esperas', AFTER_BALANCE_POLL_MS.length >= 3 && AFTER_BALANCE_POLL_MS[0] >= 2000);

const bubble = formatRechargeResult(
  {
    result: { status: 'CONFIRMED' },
    valueCents: 2000,
    cardMask: '****8383',
    loginMsisdn: '11992000282',
    targetMsisdn: '91987572274',
    latencyMs: 25000,
  },
  { balance: cmp },
);
check('aprovada tem saldo', /Saldo do destino/.test(bubble) && /Antes:/.test(bubble), bubble);
check('aprovada titulo', /APROVADA/.test(bubble), bubble);

const denied = formatRechargeResult(
  {
    result: { status: 'DENIED', message: 'CREDIT_CARD - 422 - suspected fraud' },
    valueCents: 2000,
    cardMask: '****1111',
    loginMsisdn: '11992000282',
    targetMsisdn: '91987572274',
  },
  { balance: cmp },
);
check('negada esconde saldo', !/Saldo do destino/.test(denied), denied);

const scanSummary = buildSummary({
  session: { identifier: '48996641498', segment: 'PRE_PAGO' },
  claro: {
    customer: { body: { status: 'CREATED', profile: { name: 'claro_recarga_basic' } } },
    balance: {
      ok: true,
      status: 200,
      body: { value: 2000, total: 2000, expiration_date: '2026-09-29', bonus: [] },
    },
    products: { body: { rechargeValues: [] } },
    paymentMethods: { body: [] },
    recharges: { body: [] },
    rechargesRecurring: { body: [] },
    scheduledRecharges: { body: [] },
  },
  skipWallet: true,
});
check('scan saldo cents', scanSummary.saldo?.cents === 2000, scanSummary.saldo);
check('scan saldo data', scanSummary.saldo?.expiration === '2026-09-29', scanSummary.saldo);
const scanText = formatTelegramReport(scanSummary);
check('scan mostra saldo', /Saldo:.*R\$ 20,00 · val\. 29\/09\/2026/.test(scanText), scanText);

const prepaid404 = buildSummary({
  session: { identifier: '11991000000', segment: 'CONTROLE' },
  claro: {
    customer: { body: {} },
    balance: { ok: false, status: 404, body: null },
    products: { body: { rechargeValues: [] } },
    paymentMethods: { body: [] },
    recharges: { body: [] },
    rechargesRecurring: { body: [] },
    scheduledRecharges: { body: [] },
  },
  skipWallet: true,
});
check('scan 404 prepaid', /sem saldo prepaid/.test(formatTelegramReport(prepaid404)));

if (failed) {
  console.error(`${failed} falha(s)`);
  process.exit(1);
}
console.log('ok line-balance');
