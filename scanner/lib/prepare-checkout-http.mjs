import { parseLink } from './parse-link.mjs';
import { createSession, fetchRechargeProducts } from './claro.mjs';
import { openWalletSession } from './eldorado.mjs';
import { normalizeBrMobile } from './fetch-claro-link.mjs';

/**
 * Abre SmartCheckout via HTTP (sem browser) e devolve URL direta do Eldorado.
 * @param {object} opts
 * @param {string} opts.loginUrl — JWT do número de login
 * @param {string} opts.msisdn — número que gera o login (access)
 * @param {string} [opts.targetMsisdn] — destino da recarga (padrão = msisdn)
 * @param {number} opts.valueCents
 */
export async function prepareCheckoutViaHttp({ loginUrl, msisdn, targetMsisdn = null, valueCents }) {
  const accessNumber = normalizeBrMobile(msisdn);
  const rechargeTarget = normalizeBrMobile(targetMsisdn ?? msisdn);
  if (!accessNumber) throw new Error('msisdn inválido');
  if (!rechargeTarget) throw new Error('targetMsisdn inválido');

  const parsed = parseLink(String(loginUrl ?? '').trim());
  if (parsed.kind !== 'jwt') {
    throw new Error('loginUrl deve ser select-login?t=JWT ou JWT puro');
  }

  const session = await createSession(parsed.jwt);
  const productMsisdn = accessNumber;
  const productsRes = await fetchRechargeProducts(session.id, productMsisdn);
  const products = productsRes.body?.rechargeValues ?? [];
  const cents = Number(valueCents);
  const product =
    products.find((p) => p.isAvailable === true && p.value === cents) ||
    products.find((p) => p.isAvailable === true && p.value === Math.round(cents));

  if (!product) {
    const available = products.filter((p) => p.isAvailable).map((p) => p.value / 100);
    throw new Error(
      `R$ ${(cents / 100).toFixed(0)} não disponível no login ${accessNumber}. Valores: ${available.join(', ') || 'nenhum'}`,
    );
  }

  const wallet = await openWalletSession(session.id, productMsisdn, product.id, {
    payerMsisdn: accessNumber,
    recipient: rechargeTarget,
  });
  if (wallet.error) {
    throw new Error(wallet.message ?? wallet.error);
  }

  const checkoutUrl = wallet.checkout?.body?.url;
  if (!checkoutUrl) {
    throw new Error('SmartCheckout não devolveu URL do checkout');
  }

  return {
    claroSessionId: session.id,
    msisdn: accessNumber,
    rechargeTarget,
    crossNumber: accessNumber !== rechargeTarget,
    segment: session.segment,
    product,
    checkoutUrl,
    checkoutCode: wallet.checkoutCode,
    bemobiToken: wallet.bemobiToken,
    httpLatencyMs: null,
  };
}
