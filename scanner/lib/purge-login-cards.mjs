import {
  scanWallet,
  deleteAllWalletCards,
  deleteCardEverywhere,
  unifySavedCards,
  fetchWalletCards,
} from './eldorado.mjs';
import { claroGet } from './http.mjs';

const PURGE_TIMEOUT_MS = Number(process.env.PURGE_LOGIN_TIMEOUT_MS || 8_000);
const PURGE_HTTP = { timeoutMs: 10_000, retries: 1 };

function strictPurgeEnabled() {
  return ['1', 'true', 'yes'].includes(String(process.env.PURGE_LOGIN_STRICT || '').toLowerCase());
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Remove todos os cartões vinculados ao login (wallet Eldorado + API Claro).
 * Usado no modo "Outro número" antes da recarga, para não atrapalhar a automação.
 */
export async function purgeAllLoginCards({ sessionId, msisdn, productId, timeoutMs = PURGE_TIMEOUT_MS } = {}) {
  return withTimeout(purgeAllLoginCardsInner({ sessionId, msisdn, productId }), timeoutMs, 'purge-login');
}

async function purgeAllLoginCardsInner({ sessionId, msisdn, productId }) {
  const msisdnNorm = String(msisdn ?? '').replace(/\D/g, '');
  if (!sessionId || !msisdnNorm) {
    return { removed: 0, total: 0, walletAuth: null };
  }

  const walletPromise = productId
    ? scanWallet(sessionId, msisdnNorm, productId, { max429Retries: 1, http: PURGE_HTTP })
    : Promise.resolve({ error: 'no_product' });
  const claroPromise = claroGet(`/customers/${msisdnNorm}/payment-methods`, sessionId, PURGE_HTTP).catch(
    (err) => ({ ok: false, body: null, error: err.message }),
  );

  const [wallet, claroRes] = await Promise.all([walletPromise, claroPromise]);

  let walletAuth = null;
  let walletBody = [];

  if (!wallet.error && wallet.bemobiToken) {
    walletAuth = {
      bemobiToken: wallet.bemobiToken,
      checkoutCode: wallet.checkoutCode,
      productId,
      sessionId,
      msisdn: msisdnNorm,
    };
    walletBody = Array.isArray(wallet.walletCards?.body) ? wallet.walletCards.body : [];
  } else if (wallet.error && wallet.error !== 'no_product') {
    console.log(`[purge-login] wallet ${msisdnNorm}: ${wallet.message ?? wallet.error}`);
  }

  const claroBody = claroRes.ok ? claroRes.body : null;

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
    console.log(`[purge-login] wallet ${msisdnNorm}: ${batch.ok}/${batch.total} removidos`);
  }

  if (claroOnly.length) {
    const claroDeletes = await Promise.all(
      claroOnly.map((card) =>
        deleteCardEverywhere({
          bemobiToken: walletAuth?.bemobiToken,
          checkoutCode: walletAuth?.checkoutCode,
          sessionId,
          msisdn: msisdnNorm,
          cardToken: card.token,
        }),
      ),
    );
    removed += claroDeletes.filter((r) => r.ok).length;
  }

  if (removed > 0) {
    console.log(`[purge-login] ${msisdnNorm}: ${removed}/${total} cartão(ões) removido(s)`);
  }

  return { removed, total, walletAuth };
}

/** Reabre wallet e confirma que não restou cartão (opcional — PURGE_LOGIN_STRICT=1). */
export async function purgeAllLoginCardsStrict(args) {
  const result = await purgeAllLoginCards(args);
  if (!strictPurgeEnabled() || !result.total) return result;

  if (result.removed < result.total && result.walletAuth?.bemobiToken) {
    const cardsRes = await fetchWalletCards(
      result.walletAuth.bemobiToken,
      result.walletAuth.checkoutCode,
      PURGE_HTTP,
    );
    const remaining = Array.isArray(cardsRes.body) ? cardsRes.body : [];
    if (remaining.length) {
      const retry = await deleteAllWalletCards(
        result.walletAuth.bemobiToken,
        result.walletAuth.checkoutCode,
        remaining,
      );
      return {
        ...result,
        removed: result.removed + retry.ok,
      };
    }
  }

  return result;
}
