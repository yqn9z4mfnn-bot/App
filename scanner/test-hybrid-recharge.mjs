#!/usr/bin/env node
/**
 * Teste local: HTTP prepara checkout → Edge só paga.
 * Uso:
 *   node test-hybrid-recharge.mjs <login_msisdn> <valor_reais> "PAN|MM|AAAA|CVV"
 *   node test-hybrid-recharge.mjs <login_msisdn> <destino_msisdn> <valor_reais> "PAN|MM|AAAA|CVV"
 */
import { fetchClaroLoginLink } from './lib/fetch-claro-link.mjs';
import { startSessionFromCheckoutLink } from './automation/sessions.mjs';

const args = process.argv.slice(2);
let loginMsisdn;
let targetMsisdn;
let valueReais;
let pamInfo;

if (args.length === 3) {
  [loginMsisdn, valueReais, pamInfo] = args;
  targetMsisdn = loginMsisdn;
} else if (args.length === 4) {
  [loginMsisdn, targetMsisdn, valueReais, pamInfo] = args;
} else {
  console.error(
    'Uso:\n' +
      '  node test-hybrid-recharge.mjs <login> <valor> "PAN|MM|AAAA|CVV"\n' +
      '  node test-hybrid-recharge.mjs <login> <destino> <valor> "PAN|MM|AAAA|CVV"',
  );
  process.exit(1);
}

const accessNumber = loginMsisdn.replace(/\D/g, '');
const rechargeTargetNumber = targetMsisdn.replace(/\D/g, '');
const cross = accessNumber !== rechargeTargetNumber;

const started = Date.now();
console.log('=== TESTE HÍBRIDO (HTTP → checkout URL → Edge paga) ===');
console.log('Login:', accessNumber);
if (cross) console.log('Destino:', rechargeTargetNumber, '(recarga cruzada)');
console.log('Valor: R$', valueReais.replace(/\D/g, ''));

const { link } = await fetchClaroLoginLink(accessNumber);
console.log('Link JWT OK\n');

const result = await startSessionFromCheckoutLink({
  loginUrl: link,
  accessNumber,
  rechargeTargetNumber,
  rechargeValue: valueReais.replace(/\D/g, ''),
  pamInfo,
});

const pr = result.paymentResult ?? {};
console.log('\n=== RESULTADO ===');
console.log(
  JSON.stringify(
    {
      mode: result.mode,
      crossNumber: cross,
      login: accessNumber,
      target: rechargeTargetNumber,
      status: result.status,
      gateStatus: pr.gateStatus ?? pr.status,
      gateMessage: pr.gateMessage ?? pr.message,
      visualVbv: pr.visualVbv ?? false,
      httpPrepMs: result.httpPrep?.httpLatencyMs,
      timings: result.timings,
      product: result.httpPrep?.productName,
      checkoutUrl: result.httpPrep?.checkoutUrl?.slice(0, 80) + '…',
      totalMs: result.timings?.totalMs ?? Date.now() - started,
    },
    null,
    2,
  ),
);

if (result.status !== 'done' && result.status !== '3ds_required') {
  process.exit(1);
}
