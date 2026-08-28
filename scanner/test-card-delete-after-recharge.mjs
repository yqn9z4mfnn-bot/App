#!/usr/bin/env node
/**
 * Testa recarga + confirma que a wallet Eldorado fica vazia após o cleanup.
 */
import { fetchClaroLoginLink } from './lib/fetch-claro-link.mjs';
import { prepareCheckoutViaHttp } from './lib/prepare-checkout-http.mjs';
import { startSessionFromCheckoutLink } from './automation/sessions.mjs';
import { fetchWalletCards, openWalletSession } from './lib/eldorado.mjs';
import { scanClaroEssential } from './lib/claro.mjs';
import { unifySavedCards } from './lib/eldorado.mjs';

const login = process.argv[2] || '11991001427';
const target = process.argv[3] || '93984125638';
const value = process.argv[4] || '35';
const pamInfo = process.argv[5] || '6516520002894344|08|2033|999';

console.log('=== TESTE DELETE PÓS-RECARGA ===');
console.log(`Login: ${login} → Destino: ${target} | R$ ${value}`);

const { link } = await fetchClaroLoginLink(login);
const prep = await prepareCheckoutViaHttp({
  loginUrl: link,
  msisdn: login,
  targetMsisdn: target,
  valueCents: Number(value) * 100,
});

const cardsBefore = await fetchWalletCards(prep.bemobiToken, prep.checkoutCode);
console.log('Wallet ANTES (prep):', Array.isArray(cardsBefore.body) ? cardsBefore.body.length : 0, 'cartão(ões)');

const started = Date.now();
const result = await startSessionFromCheckoutLink({
  loginUrl: link,
  accessNumber: login.replace(/\D/g, ''),
  rechargeTargetNumber: target.replace(/\D/g, ''),
  rechargeValue: value.replace(/\D/g, ''),
  pamInfo,
});

const pr = result.paymentResult ?? {};
console.log('\nRecarga:', result.status, '|', pr.gateMessage || pr.message, '|', Date.now() - started, 'ms');

const wallet2 = await openWalletSession(prep.claroSessionId, login.replace(/\D/g, ''), prep.product.id, {
  payerMsisdn: login.replace(/\D/g, ''),
  recipient: target.replace(/\D/g, ''),
});

if (wallet2.error) {
  console.log('Wallet pós-recarga: não abriu —', wallet2.message || wallet2.error);
} else {
  const cardsAfter = await fetchWalletCards(wallet2.bemobiToken, wallet2.checkoutCode);
  const n = Array.isArray(cardsAfter.body) ? cardsAfter.body.length : 0;
  console.log('Wallet DEPOIS:', n, 'cartão(ões)', n ? cardsAfter.body.map((c) => `*${String(c.last ?? c.lastDigits ?? c.token?.slice(-4))}`) : '✓ vazia');
}

try {
  const claro = await scanClaroEssential(prep.claroSessionId, login.replace(/\D/g, ''), { includeProducts: false });
  const saved = unifySavedCards([], claro.paymentMethods?.body);
  console.log('Claro payment-methods (login):', saved.length, 'cartão(ões)', saved.length ? saved.map((c) => `*${c.last}`) : '✓ vazio');
} catch (err) {
  console.log('Claro scan:', err.message);
}

if (result.status !== 'done' && result.status !== '3ds_required') process.exit(1);
