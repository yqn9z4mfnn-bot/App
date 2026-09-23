import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.ADMIN_DB = join(mkdtempSync(join(tmpdir(), 'wallet-test-')), 'admin.db');
process.env.WALLET_BILLING = '1';
process.env.WALLET_ADMIN_FREE = '0';

const { openAdminDb } = await import('../lib/admin-db.mjs');
const {
  creditUserBalance,
  getUserBalanceCents,
  reserveRechargeFee,
  settleRechargeFee,
  assertCanStartRecharge,
  processPushinPixWebhook,
  RECHARGE_FEE_CONFIRMED_CENTS,
  RECHARGE_FEE_UNCONFIRMED_CENTS,
} = await import('../lib/user-wallet.mjs');
const { upsertTelegramUser, getAdminDb } = await import('../lib/admin-db.mjs');

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

check('hold 3', reserveRechargeFee('12345', { refId: 1 }).ok);
settleRechargeFee('12345', { confirmed: true, refId: 1 });
check('after confirmed', getUserBalanceCents('12345') === 1000 - RECHARGE_FEE_CONFIRMED_CENTS);

check('hold again', reserveRechargeFee('12345', { refId: 2 }).ok);
settleRechargeFee('12345', { confirmed: false, refId: 2 });
check(
  'after unconfirmed',
  getUserBalanceCents('12345') === 1000 - RECHARGE_FEE_CONFIRMED_CENTS - RECHARGE_FEE_UNCONFIRMED_CENTS,
);

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
