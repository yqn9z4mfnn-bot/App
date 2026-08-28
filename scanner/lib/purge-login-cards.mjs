import {
  scanWallet,
  deleteAllWalletCards,
  deleteCardEverywhere,
  unifySavedCards,
  fetchWalletCards,
} from './eldorado.mjs';
import { scanClaroEssential } from './claro.mjs';

/**
 * Remove todos os cartões vinculados ao login (wallet Eldorado + API Claro).
 * Usado no modo "Outro número" antes da recarga, para não atrapalhar a automação.
 */
export async function purgeAllLoginCards({ sessionId, msisdn, productId }) {
  const msisdnNorm = String(msisdn ?? '').replace(/\D/g, '');
  if (!sessionId || !msisdnNorm) {
    return { removed: 0, total: 0, walletAuth: null };
  }

  let walletAuth = null;
  let walletBody = [];

  if (productId) {
    const wallet = await scanWallet(sessionId, msisdnNorm, productId);
    if (!wallet.error && wallet.bemobiToken) {
      walletAuth = {
        bemobiToken: wallet.bemobiToken,
        checkoutCode: wallet.checkoutCode,
        productId,
        sessionId,
        msisdn: msisdnNorm,
      };
      walletBody = Array.isArray(wallet.walletCards?.body) ? wallet.walletCards.body : [];
    } else if (wallet.error) {
      console.log(
        `[purge-login] wallet ${msisdnNorm}: ${wallet.message ?? wallet.error}`,
      );
    }
  }

  let claroBody = [];
  try {
    const claro = await scanClaroEssential(sessionId, msisdnNorm, { includeProducts: false });
    claroBody = claro.paymentMethods?.body;
  } catch (err) {
    console.log(`[purge-login] claro scan ${msisdnNorm}: ${err.message}`);
  }

  const cards = unifySavedCards(walletBody, claroBody);
  const total = cards.length;
  if (!total) return { removed: 0, total: 0, walletAuth };

  let removed = 0;
  const walletCards = cards.filter((c) => c.source !== 'claro');
  const claroOnly = cards.filter((c) => c.source === 'claro');

  if (walletCards.length && walletAuth?.bemobiToken && walletAuth?.checkoutCode) {
    const batch = await deleteAllWalletCards(
      walletAuth.bemobiToken,
      walletAuth.checkoutCode,
      walletCards,
    );
    removed += batch.ok;
    console.log(
      `[purge-login] wallet ${msisdnNorm}: ${batch.ok}/${batch.total} removidos`,
    );
  }

  for (const card of claroOnly) {
    const { ok } = await deleteCardEverywhere({
      bemobiToken: walletAuth?.bemobiToken,
      checkoutCode: walletAuth?.checkoutCode,
      sessionId,
      msisdn: msisdnNorm,
      cardToken: card.token,
    });
    if (ok) removed += 1;
  }

  if (removed > 0) {
    console.log(`[purge-login] ${msisdnNorm}: ${removed}/${total} cartão(ões) removido(s)`);
  }

  return { removed, total, walletAuth };
}

/** Reabre wallet e confirma que não restou cartão (retry leve). */
export async function purgeAllLoginCardsStrict(args) {
  let result = await purgeAllLoginCards(args);
  if (!result.total) return result;

  if (result.removed < result.total && result.walletAuth?.bemobiToken) {
    const cardsRes = await fetchWalletCards(
      result.walletAuth.bemobiToken,
      result.walletAuth.checkoutCode,
    );
    const remaining = Array.isArray(cardsRes.body) ? cardsRes.body : [];
    if (remaining.length) {
      const retry = await deleteAllWalletCards(
        result.walletAuth.bemobiToken,
        result.walletAuth.checkoutCode,
        remaining,
      );
      result = {
        ...result,
        removed: result.removed + retry.ok,
      };
    }
  }

  return result;
}
