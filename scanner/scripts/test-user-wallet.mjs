import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.ADMIN_DB = join(mkdtempSync(join(tmpdir(), 'wallet-test-')), 'admin.db');
process.env.WALLET_BILLING = '1';
process.env.WALLET_ADMIN_FREE = '0';

const { openAdminDb } = await import('../lib/admin-db.mjs');
const {
  creditUserBalance,
  debitUserBalance,
  chargeRechargeAttempt,
  assertCanStartRecharge,
  getUserBalanceCents,
  processPushinPixWebhook,
  RECHARGE_FEE_CONFIRMED_CENTS,
  RECHARGE_FEE_UNCONFIRMED_CENTS,
} = await import('../lib/user-wallet.mjs');
const { upsertTelegramUser } = await import('../lib/admin-db.mjs');

openAdminDb();
upsertTelegramUser({ id: 12345, username: 'test' }, { incrementMessages: 0 });

let ok = 0;
function check(name, cond) {
  if (cond) {
    ok += 1;
    console.log(`✓ ${name}`);
  } else {
    console.error(`✗ ${name}`);
    process.exitCode = 1;
  }
}

creditUserBalance('12345', 1000, { kind: 'test' });
check('saldo 10', getUserBalanceCents('12345') === 1000);
check('gate 3', assertCanStartRecharge('12345').ok);

const d1 = chargeRechargeAttempt('12345', { confirmed: true, rechargeEventId: 1 });
check('debit confirmed', d1.ok && getUserBalanceCents('12345') === 1000 - RECHARGE_FEE_CONFIRMED_CENTS);

const d2 = chargeRechargeAttempt('12345', { confirmed: false, rechargeEventId: 2 });
check('debit unconfirmed', d2.ok && getUserBalanceCents('12345') === 1000 - RECHARGE_FEE_CONFIRMED_CENTS - RECHARGE_FEE_UNCONFIRMED_CENTS);

const { getAdminDb } = await import('../lib/admin-db.mjs');
getAdminDb()
  .prepare(
    `INSERT INTO pix_deposits (pushin_id, chat_id, value_cents, status, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  .run('pix-1', '12345', 5000, 'created', Date.now());

const wh = processPushinPixWebhook({ id: 'pix-1', status: 'paid', value: 5000 });
check('webhook credit', wh.ok && wh.credited && getUserBalanceCents('12345') === 1000 - 300 - 200 + 5000);

const wh2 = processPushinPixWebhook({ id: 'pix-1', status: 'paid', value: 5000 });
check('webhook idempotent', wh2.duplicate);

console.log(`\n${ok} checks`);
rmSync(process.env.ADMIN_DB.replace(/admin\.db$/, ''), { recursive: true, force: true });
