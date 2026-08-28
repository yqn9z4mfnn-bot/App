import { parseLink } from './parse-link.mjs';
import { createSession, fetchRechargeProducts } from './claro.mjs';
import { openWalletSession } from './eldorado.mjs';
import { normalizeBrMobile } from './fetch-claro-link.mjs';

/**
 * Abre SmartCheckout via HTTP (sem browser) e devolve URL direta do Eldorado.
 */
export async function prepareCheckoutViaHttp({ loginUrl, msisdn, valueCents }) {
  const number = normalizeBrMobile(msisdn);
  if (!number) throw new Error('msisdn inválido');

  const parsed = parseLink(String(loginUrl ?? '').trim());
  if (parsed.kind !== 'jwt') {
    throw new Error('loginUrl deve ser select-login?t=JWT ou JWT puro');
  }

  const session = await createSession(parsed.jwt);
  const productsRes = await fetchRechargeProducts(session.id, number);
  const products = productsRes.body?.rechargeValues ?? [];
  const cents = Number(valueCents);
  const product =
    products.find((p) => p.isAvailable === true && p.value === cents) ||
    products.find((p) => p.isAvailable === true && p.value === Math.round(cents));

  if (!product) {
    const available = products.filter((p) => p.isAvailable).map((p) => p.value / 100);
    throw new Error(
      `R$ ${(cents / 100).toFixed(0)} não disponível. Valores: ${available.join(', ') || 'nenhum'}`,
    );
  }

  const wallet = await openWalletSession(session.id, number, product.id);
  if (wallet.error) {
    throw new Error(wallet.message ?? wallet.error);
  }

  const checkoutUrl = wallet.checkout?.body?.url;
  if (!checkoutUrl) {
    throw new Error('SmartCheckout não devolveu URL do checkout');
  }

  return {
    claroSessionId: session.id,
    msisdn: number,
    segment: session.segment,
    product,
    checkoutUrl,
    checkoutCode: wallet.checkoutCode,
    bemobiToken: wallet.bemobiToken,
    httpLatencyMs: null,
  };
}
