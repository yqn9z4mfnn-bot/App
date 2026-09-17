import { withBusyRetry, getAdminDb, isTelegramUserAdmin } from './admin-db.mjs';
import { createPixCashIn, fetchPushinTransaction, pushinPayConfigured } from './pushinpay.mjs';
import { notifyTelegramChat } from './telegram-notify.mjs';

export const RECHARGE_FEE_CONFIRMED_CENTS = Math.max(
  0,
  Number(process.env.WALLET_RECHARGE_CONFIRMED_CENTS) || 300,
);
export const RECHARGE_FEE_UNCONFIRMED_CENTS = Math.max(
  0,
  Number(process.env.WALLET_RECHARGE_UNCONFIRMED_CENTS) || 200,
);

function getDb() {
  return getAdminDb();
}

function runInTransaction(database, fn) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  }
}

export function formatWalletBrl(cents) {
  const n = Math.round(Number(cents) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}R$ ${(abs / 100).toFixed(2).replace('.', ',')}`;
}

export function walletBillingEnabled() {
  if (String(process.env.WALLET_BILLING || '').toLowerCase() === '0') return false;
  if (String(process.env.WALLET_BILLING || '').toLowerCase() === '1') return true;
  return pushinPayConfigured();
}

export function walletBillingRequiredForChat(chatId) {
  if (!walletBillingEnabled()) return false;
  const adminFree = String(process.env.WALLET_ADMIN_FREE ?? '1').toLowerCase() !== '0';
  if (adminFree && isTelegramUserAdmin(chatId)) return false;
  return true;
}

export function getUserBalanceCents(chatId) {
  return withBusyRetry(() => {
    const row = getDb().prepare('SELECT balance_cents FROM user_balances WHERE chat_id = ?').get(String(chatId));
    return row?.balance_cents ?? 0;
  });
}

function ensureBalanceRow(chatId, database) {
  const id = String(chatId);
  const row = database.prepare('SELECT chat_id FROM user_balances WHERE chat_id = ?').get(id);
  if (row) return;
  database.prepare('INSERT INTO user_balances (chat_id, balance_cents, updated_at) VALUES (?, 0, ?)').run(id, Date.now());
}

function applyLedgerEntry(database, { chatId, amountCents, kind, refId = null, detail = null }) {
  const id = String(chatId);
  ensureBalanceRow(id, database);
  const now = Date.now();
  database
    .prepare(
      `INSERT INTO balance_ledger (created_at, chat_id, amount_cents, kind, ref_id, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(now, id, amountCents, kind, refId, detail ? JSON.stringify(detail) : null);
  database
    .prepare('UPDATE user_balances SET balance_cents = balance_cents + ?, updated_at = ? WHERE chat_id = ?')
    .run(amountCents, now, id);
  const bal = database.prepare('SELECT balance_cents FROM user_balances WHERE chat_id = ?').get(id);
  return bal?.balance_cents ?? 0;
}

export function creditUserBalance(chatId, amountCents, { kind, refId = null, detail = null } = {}) {
  const delta = Math.round(Number(amountCents));
  if (!Number.isFinite(delta) || delta <= 0) throw new Error('crédito inválido');
  return withBusyRetry(() => {
    const database = getDb();
    return runInTransaction(database, () =>
      applyLedgerEntry(database, { chatId, amountCents: delta, kind, refId, detail }),
    );
  });
}

export function debitUserBalance(chatId, amountCents, { kind, refId = null, detail = null, allowNegative = false } = {}) {
  const delta = Math.round(Number(amountCents));
  if (!Number.isFinite(delta) || delta <= 0) throw new Error('débito inválido');
  return withBusyRetry(() => {
    const database = getDb();
    return runInTransaction(database, () => {
      ensureBalanceRow(String(chatId), database);
      const row = database.prepare('SELECT balance_cents FROM user_balances WHERE chat_id = ?').get(String(chatId));
      const bal = row?.balance_cents ?? 0;
      if (!allowNegative && bal < delta) {
        return { ok: false, balanceCents: bal, neededCents: delta };
      }
      const newBal = applyLedgerEntry(database, {
        chatId,
        amountCents: -delta,
        kind,
        refId,
        detail,
      });
      return { ok: true, balanceCents: newBal, debitedCents: delta };
    });
  });
}

export function minBalanceToStartRechargeCents() {
  return RECHARGE_FEE_CONFIRMED_CENTS;
}

function insufficientBalanceMessage(bal, need) {
  return (
    `Saldo insuficiente: você tem <b>${formatWalletBrl(bal)}</b>, ` +
    `mas cada recarga exige pelo menos <b>${formatWalletBrl(need)}</b> ` +
    `(R$ 3 confirmada / R$ 2 não confirmada).\n\nUse <b>/pix</b> para adicionar saldo ou <b>/saldo</b> para consultar.`
  );
}

/** Só consulta — não reserva saldo. */
export function assertCanStartRecharge(chatId) {
  if (!walletBillingRequiredForChat(chatId)) return { ok: true };
  const bal = getUserBalanceCents(chatId);
  const need = minBalanceToStartRechargeCents();
  if (bal < need) {
    return { ok: false, balanceCents: bal, neededCents: need, message: insufficientBalanceMessage(bal, need) };
  }
  return { ok: true, balanceCents: bal };
}

/**
 * Reserva tarifa máxima (R$ 3) antes do checkout — impede 2 recargas paralelas com o mesmo saldo.
 */
export function reserveRechargeFee(chatId, { refId = null } = {}) {
  if (!walletBillingRequiredForChat(chatId)) {
    return { ok: true, skipped: true, reservedCents: 0 };
  }
  const need = RECHARGE_FEE_CONFIRMED_CENTS;
  const result = debitUserBalance(chatId, need, {
    kind: 'recharge_hold',
    refId: refId != null ? String(refId) : null,
    detail: { phase: 'hold', feeCents: need },
  });
  if (!result.ok) {
    const bal = result.balanceCents ?? 0;
    return {
      ok: false,
      balanceCents: bal,
      neededCents: need,
      message: insufficientBalanceMessage(bal, need),
    };
  }
  return { ok: true, reservedCents: need, balanceCents: result.balanceCents };
}

/**
 * Ajusta após a tentativa: hold já descontou R$ 3; não confirmada devolve R$ 1 (custo líquido R$ 2).
 */
export function settleRechargeFee(chatId, { confirmed, rechargeEventId = null, refId = null } = {}) {
  if (!walletBillingRequiredForChat(chatId)) return { ok: true, skipped: true };
  const actual = confirmed ? RECHARGE_FEE_CONFIRMED_CENTS : RECHARGE_FEE_UNCONFIRMED_CENTS;
  const hold = RECHARGE_FEE_CONFIRMED_CENTS;
  const refund = Math.max(0, hold - actual);
  let balanceCents = getUserBalanceCents(chatId);
  if (refund > 0) {
    balanceCents = creditUserBalance(chatId, refund, {
      kind: 'recharge_hold_refund',
      refId: rechargeEventId != null ? String(rechargeEventId) : refId != null ? String(refId) : null,
      detail: { confirmed: Boolean(confirmed), feeCents: actual, refundCents: refund },
    });
  }
  withBusyRetry(() => {
    getDb()
      .prepare(
        `INSERT INTO balance_ledger (created_at, chat_id, amount_cents, kind, ref_id, detail)
         VALUES (?, ?, 0, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        String(chatId),
        confirmed ? 'recharge_confirmed' : 'recharge_unconfirmed',
        rechargeEventId != null ? String(rechargeEventId) : refId != null ? String(refId) : null,
        JSON.stringify({ confirmed: Boolean(confirmed), feeCents: actual, via: 'hold_settle' }),
      );
  });
  return { ok: true, skipped: false, balanceCents, feeCents: actual, refundedCents: refund };
}

/** @deprecated use reserveRechargeFee + settleRechargeFee */
export function chargeRechargeAttempt(chatId, opts) {
  const hold = reserveRechargeFee(chatId, { refId: opts?.rechargeEventId });
  if (!hold.ok && !hold.skipped) return hold;
  return settleRechargeFee(chatId, opts);
}

function webhookBaseUrl() {
  const u = String(process.env.WALLET_WEBHOOK_BASE_URL || process.env.ADMIN_PUBLIC_URL || '').trim();
  if (!u) throw new Error('Defina WALLET_WEBHOOK_BASE_URL (URL pública do painel admin, ex. https://host:3080)');
  return u.replace(/\/$/, '');
}

export function buildPixWebhookUrl() {
  return `${webhookBaseUrl()}/api/webhooks/pushinpay/pix`;
}

export function validatePushinWebhookRequest(req) {
  const insecure = String(process.env.WALLET_WEBHOOK_INSECURE || '').toLowerCase() === '1';
  if (insecure) return true;
  const headerName = String(process.env.PUSHINPAY_WEBHOOK_HEADER || process.env.PUSHINPAY_WEBHOOK_SECRET_HEADER || '')
    .trim()
    .toLowerCase();
  const expected = String(process.env.PUSHINPAY_WEBHOOK_SECRET || process.env.PUSHINPAY_WEBHOOK_HEADER_VALUE || '').trim();
  if (!headerName || !expected) {
    console.warn('[wallet] webhook sem header secreto — defina PUSHINPAY_WEBHOOK_HEADER e PUSHINPAY_WEBHOOK_SECRET');
    return false;
  }
  const got = String(req.headers[headerName] ?? req.headers[headerName.replace(/-/g, '_')] ?? '').trim();
  return got === expected;
}

export async function createPixDepositForUser(chatId, valueCents) {
  if (!pushinPayConfigured()) throw new Error('PIX indisponível (PUSHINPAY_TOKEN ausente)');
  const cents = Math.round(Number(valueCents));
  if (!Number.isFinite(cents) || cents < 500) {
    throw new Error('Valor mínimo para recarga de saldo: R$ 5,00');
  }
  const webhookUrl = buildPixWebhookUrl();
  const tx = await createPixCashIn({
    valueCents: cents,
    webhookUrl,
    description: `Saldo bot Telegram ${chatId}`,
  });
  const pushinId = String(tx.id ?? '');
  if (!pushinId) throw new Error('PushinPay não retornou id da transação');
  withBusyRetry(() => {
    getDb()
      .prepare(
        `INSERT INTO pix_deposits (pushin_id, chat_id, value_cents, status, created_at, raw_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(pushinId, String(chatId), cents, String(tx.status || 'created'), Date.now(), JSON.stringify(tx));
  });
  return { pushinId, valueCents: cents, qrCode: tx.qr_code ?? null, qrCodeBase64: tx.qr_code_base64 ?? null, status: tx.status };
}

export function processPushinPixWebhook(payload) {
  const pushinId = String(payload?.id ?? '');
  const status = String(payload?.status ?? '').toLowerCase();
  const value = Math.round(Number(payload?.value));
  if (!pushinId) return { ok: false, reason: 'missing_id' };
  if (status !== 'paid') return { ok: true, ignored: true, status };

  return withBusyRetry(() => {
    const database = getDb();
    return runInTransaction(database, () => {
      const dep = database.prepare('SELECT * FROM pix_deposits WHERE pushin_id = ?').get(pushinId);
      if (!dep) {
        console.warn(`[wallet] webhook paid sem depósito local id=${pushinId}`);
        return { ok: false, reason: 'unknown_deposit' };
      }
      if (dep.status === 'paid') return { ok: true, duplicate: true, chatId: dep.chat_id };
      const creditCents = Number.isFinite(value) && value > 0 ? value : dep.value_cents;
      database
        .prepare('UPDATE pix_deposits SET status = ?, paid_at = ?, raw_json = ? WHERE pushin_id = ?')
        .run('paid', Date.now(), JSON.stringify(payload), pushinId);
      const newBal = applyLedgerEntry(database, {
        chatId: dep.chat_id,
        amountCents: creditCents,
        kind: 'pix_deposit',
        refId: pushinId,
        detail: { end_to_end_id: payload?.end_to_end_id ?? null },
      });
      return { ok: true, credited: true, chatId: dep.chat_id, creditCents, balanceCents: newBal };
    });
  });
}

/** Confere na API PushinPay e credita se status=paid (fallback quando webhook não chega). */
export async function reconcilePixDepositFromApi(pushinId, { expectedChatId = null } = {}) {
  const id = String(pushinId ?? '').trim();
  if (!id) return { ok: false, reason: 'missing_id' };
  const dep = withBusyRetry(() =>
    getDb().prepare('SELECT * FROM pix_deposits WHERE pushin_id = ?').get(id),
  );
  if (!dep) return { ok: false, reason: 'unknown_deposit' };
  if (expectedChatId != null && String(dep.chat_id) !== String(expectedChatId)) {
    return { ok: false, reason: 'wrong_user' };
  }
  if (dep.status === 'paid') {
    return { ok: true, duplicate: true, chatId: dep.chat_id, balanceCents: getUserBalanceCents(dep.chat_id) };
  }
  let tx;
  try {
    tx = await fetchPushinTransaction(id);
  } catch (err) {
    return { ok: false, reason: 'api_error', error: err.message };
  }
  const status = String(tx.status ?? '').toLowerCase();
  if (status !== 'paid') {
    return { ok: true, pending: true, status, chatId: dep.chat_id };
  }
  const value = Math.round(Number(tx.value ?? dep.value_cents));
  return handlePushinPixWebhook({ id, status: 'paid', value, end_to_end_id: tx.end_to_end_id ?? null });
}

export async function handlePushinPixWebhook(payload) {
  const result = processPushinPixWebhook(payload);
  if (result.ok && result.credited && result.chatId) {
    const n = await notifyTelegramChat(
      result.chatId,
      `✅ <b>PIX recebido</b>\n\n` +
        `+ <b>${formatWalletBrl(result.creditCents)}</b>\n` +
        `Saldo atual: <b>${formatWalletBrl(result.balanceCents)}</b>\n\n` +
        `Tarifas: <b>R$ 3,00</b> por recarga confirmada · <b>R$ 2,00</b> se não confirmar.`,
    );
    if (!n.ok) console.warn('[wallet] aviso telegram pós-pix:', n.error);
  }
  return result;
}

export function buildPixAmountKeyboard() {
  const amounts = [2000, 5000, 10000, 20000, 50000];
  const rows = [];
  for (let i = 0; i < amounts.length; i += 2) {
    const row = amounts.slice(i, i + 2).map((c) => ({
      text: formatWalletBrl(c),
      callback_data: `wallet:pix:${c}`,
    }));
    rows.push(row);
  }
  rows.push([{ text: '↩️ Voltar', callback_data: 'wallet:back' }]);
  return { inline_keyboard: rows };
}

export function formatWalletHelp(chatId) {
  const bal = getUserBalanceCents(chatId);
  const billing = walletBillingRequiredForChat(chatId);
  const lines = [
    `<b>💰 Seu saldo</b>: <b>${formatWalletBrl(bal)}</b>`,
    '',
  ];
  if (billing) {
    lines.push(
      'Cada tentativa de recarga desconta do saldo:',
      `• ✅ Confirmada: <b>${formatWalletBrl(RECHARGE_FEE_CONFIRMED_CENTS)}</b>`,
      `• ❌ Não confirmada: <b>${formatWalletBrl(RECHARGE_FEE_UNCONFIRMED_CENTS)}</b>`,
      '',
      'Para adicionar saldo via PIX, use <b>/pix</b> ou o botão abaixo.',
    );
  } else if (!walletBillingEnabled()) {
    lines.push('Cobrança por saldo está desligada neste ambiente.');
  } else {
    lines.push('Conta admin — recargas sem desconto de saldo.');
  }
  return lines.join('\n');
}
