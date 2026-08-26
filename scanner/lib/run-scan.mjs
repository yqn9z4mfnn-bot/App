import { parseLink } from './parse-link.mjs';
import { createSession, scanClaroApi } from './claro.mjs';
import { scanWallet } from './eldorado.mjs';
import { buildSummary } from './report.mjs';

export async function runScan(link, { skipWallet = false } = {}) {
  const started = Date.now();
  const parsed = parseLink(link);

  if (parsed.kind !== 'jwt') {
    throw new Error('Use link select-login com ?t=JWT ou o JWT puro.');
  }

  const session = await createSession(parsed.jwt);
  const msisdn = session.identifier;
  const claro = await scanClaroApi(session.id, msisdn);

  const products = claro.products?.body?.rechargeValues ?? [];
  const firstProduct =
    products.find((p) => p.isAvailable !== false) ?? products[0];

  let wallet = null;
  if (!skipWallet && firstProduct?.id) {
    try {
      wallet = await scanWallet(session.id, msisdn, firstProduct.id);
    } catch (err) {
      wallet = {
        error: 'wallet_exception',
        message: err.message,
        walletCards: null,
      };
    }
  }

  const summary = buildSummary({ session, claro, wallet, skipWallet });
  summary.meta = {
    latencyMs: Date.now() - started,
    sessionId: `${session.id.slice(0, 8)}…`,
  };

  const walletAuth =
    wallet?.bemobiToken && wallet?.checkoutCode
      ? {
          bemobiToken: wallet.bemobiToken,
          checkoutCode: wallet.checkoutCode,
          sessionId: session.id,
          msisdn,
          productId: firstProduct?.id,
        }
      : null;

  return { summary, session, claro, wallet, walletAuth, link: parsed.jwt };
}
