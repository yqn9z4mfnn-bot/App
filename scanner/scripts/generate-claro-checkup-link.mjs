#!/usr/bin/env node
/**
 * Gera links Claro só para checkup de pagamento (sem bot / sem cartão).
 *
 * Uso:
 *   node scripts/generate-claro-checkup-link.mjs [loginMsisdn] [valorReais] [destinoOpcional]
 *
 * Ex.:
 *   node scripts/generate-claro-checkup-link.mjs 11991002236 30
 *   node scripts/generate-claro-checkup-link.mjs 11991002236 35 15988182676
 *
 * Saída: link JWT minhaclaro + URL SmartCheckout (Eldorado) para abrir no navegador.
 */
import '../lib/load-env.mjs';
import { fetchClaroLoginLink } from '../lib/fetch-claro-link.mjs';
import { generateLoginMsisdn } from '../lib/generate-msisdn.mjs';
import { prepareCheckoutViaHttp } from '../lib/prepare-checkout-http.mjs';
import { normalizeBrMobile } from '../lib/fetch-claro-link.mjs';

const loginArg = process.argv[2];
const valueArg = process.argv[3];
const destArg = process.argv[4];

const valueReais = valueArg ? Number(String(valueArg).replace(',', '.')) : 30;
if (!Number.isFinite(valueReais) || valueReais <= 0) {
  console.error('Valor inválido. Ex.: 30 ou 35');
  process.exit(1);
}
const valueCents = Math.round(valueReais * 100);

let loginMsisdn = loginArg ? normalizeBrMobile(loginArg) : null;
let loginUrl;

if (loginMsisdn) {
  const { link } = await fetchClaroLoginLink(loginMsisdn);
  loginUrl = link;
} else {
  const gen = await generateLoginMsisdn({ maxAttempts: 6 });
  loginMsisdn = gen.msisdn;
  loginUrl = gen.link;
}

const targetMsisdn = destArg ? normalizeBrMobile(destArg) : loginMsisdn;
if (destArg && !targetMsisdn) {
  console.error('Destino inválido');
  process.exit(1);
}

const prep = await prepareCheckoutViaHttp({
  loginUrl,
  msisdn: loginMsisdn,
  targetMsisdn,
  valueCents,
});

console.log('');
console.log('=== Checkup pagamento Claro (só links) ===');
console.log(`Login:   ${loginMsisdn}`);
console.log(`Destino: ${prep.rechargeTarget}${prep.crossNumber ? ' (outro número)' : ''}`);
console.log(`Valor:   R$ ${(valueCents / 100).toFixed(2)}`);
console.log('');
console.log('Portal JWT (minhaclaro):');
console.log(loginUrl);
console.log('');
console.log('SmartCheckout (pagamento — abra no navegador):');
console.log(prep.checkoutUrl);
console.log('');
console.log(`Sessão Claro: ${prep.claroSessionId}`);
