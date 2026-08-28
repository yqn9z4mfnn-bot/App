#!/usr/bin/env node
/**
 * Teste local: HTTP prepara checkout → Edge só paga.
 * Uso: node test-hybrid-recharge.mjs <msisdn> <valor_reais> "PAN|MM|AAAA|CVV"
 */
import { fetchClaroLoginLink } from './lib/fetch-claro-link.mjs';
import { startSessionFromCheckoutLink } from './automation/sessions.mjs';

const [msisdn, valueReais, pamInfo] = process.argv.slice(2);
if (!msisdn || !valueReais || !pamInfo) {
  console.error('Uso: node test-hybrid-recharge.mjs <msisdn> <valor> "PAN|MM|AAAA|CVV"');
  process.exit(1);
}

const started = Date.now();
console.log('=== TESTE HÍBRIDO (HTTP → checkout URL → Edge paga) ===');
console.log('Número:', msisdn, '| Valor: R$', valueReais);

const { link } = await fetchClaroLoginLink(msisdn);
console.log('Link JWT OK\n');

const result = await startSessionFromCheckoutLink({
  loginUrl: link,
  accessNumber: msisdn.replace(/\D/g, ''),
  rechargeValue: valueReais.replace(/\D/g, ''),
  pamInfo,
});

const pr = result.paymentResult ?? {};
console.log('\n=== RESULTADO ===');
console.log(
  JSON.stringify(
    {
      mode: result.mode,
      status: result.status,
      gateStatus: pr.gateStatus ?? pr.status,
      gateMessage: pr.gateMessage ?? pr.message,
      httpPrepMs: result.httpPrep?.httpLatencyMs,
      product: result.httpPrep?.productName,
      checkoutUrl: result.httpPrep?.checkoutUrl?.slice(0, 80) + '…',
      totalMs: Date.now() - started,
    },
    null,
    2,
  ),
);

if (result.status !== 'done' && result.status !== '3ds_required') {
  process.exit(1);
}
