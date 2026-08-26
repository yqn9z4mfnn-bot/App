import { parseLink } from './parse-link.mjs';
import { createSession, scanClaroEssential, scanClaroApi } from './claro.mjs';
import { claroGet } from './http.mjs';
import { scanWallet, deleteWalletCard, deleteAllWalletCards } from './eldorado.mjs';
import { buildSummary } from './report.mjs';

function pickProductId(productsBody) {
  const products = productsBody?.rechargeValues ?? [];
  const first = products.find((p) => p.isAvailable !== false) ?? products[0];
  return first?.id ?? null;
}

export async function runScan(link, { skipWallet = false, full = false } = {}) {
  const started = Date.now();
  const parsed = parseLink(link);

  if (parsed.kind !== 'jwt') {
    throw new Error('Use link select-login com ?t=JWT ou o JWT puro.');
  }

  const session = await createSession(parsed.jwt);
  const msisdn = session.identifier;

  let claro;
  let wallet = null;

  if (full || skipWallet) {
    claro = skipWallet
      ? await scanClaroEssential(session.id, msisdn)
      : await scanClaroApi(session.id, msisdn);
    if (!skipWallet) {
      const productId = pickProductId(claro.products?.body);
      if (productId) {
        try {
          wallet = await scanWallet(session.id, msisdn, productId);
        } catch (err) {
          wallet = { error: 'wallet_exception', message: err.message, walletCards: null };
        }
      }
    }
  } else {
    // Rápido: products primeiro, depois resto Claro + wallet em paralelo
    const productsRes = await claroGet(`/customers/${msisdn}/products`, session.id);
    const productId = pickProductId(productsRes.body);

    const [claroEssential, walletResult] = await Promise.all([
      scanClaroEssential(session.id, msisdn, { includeProducts: false }),
      productId
        ? scanWallet(session.id, msisdn, productId).catch((err) => ({
            error: 'wallet_exception',
            message: err.message,
            walletCards: null,
          }))
        : Promise.resolve(null),
    ]);

    claro = { products: productsRes, ...claroEssential };
    wallet = walletResult;
  }

  const summary = buildSummary({ session, claro, wallet, skipWallet });
  summary.meta = {
    latencyMs: Date.now() - started,
    sessionId: `${session.id.slice(0, 8)}…`,
    mode: full ? 'full' : skipWallet ? 'no-wallet' : 'fast',
  };

  const walletAuth =
    wallet?.bemobiToken && wallet?.checkoutCode
      ? {
          bemobiToken: wallet.bemobiToken,
          checkoutCode: wallet.checkoutCode,
          sessionId: session.id,
          msisdn,
          productId: pickProductId(claro.products?.body),
        }
      : null;

  return { summary, session, claro, wallet, walletAuth, link: parsed.jwt };
}

export async function removeCard(link, cardToken) {
  const { walletAuth, wallet } = await runScan(link, { skipWallet: false, full: false });
  if (!walletAuth) {
    throw new Error(wallet?.message ?? 'Não foi possível abrir sessão wallet');
  }

  const cards = wallet?.walletCards?.body ?? [];
  const card = cards.find((c) => c.token === cardToken);
  if (!card) {
    throw new Error('Cartão não encontrado na wallet');
  }

  const res = await deleteWalletCard(
    walletAuth.bemobiToken,
    walletAuth.checkoutCode,
    cardToken,
  );

  if (res.status !== 200 && res.status !== 204) {
    throw new Error(`Falha ao remover (${res.status})`);
  }

  return { removed: card, walletAuth };
}

export async function removeAllCards(link) {
  const { walletAuth, wallet } = await runScan(link, { skipWallet: false, full: false });
  if (!walletAuth) {
    throw new Error(wallet?.message ?? 'Não foi possível abrir sessão wallet');
  }

  const cards = wallet?.walletCards?.body ?? [];
  if (cards.length === 0) {
    return { ok: 0, total: 0, cards: [] };
  }

  const result = await deleteAllWalletCards(
    walletAuth.bemobiToken,
    walletAuth.checkoutCode,
    cards,
  );
  return { ...result, cards };
}
