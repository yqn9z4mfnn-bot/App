import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.ADMIN_DB = join(mkdtempSync(join(tmpdir(), 'wallet-fee-')), 'admin.db');
process.env.WALLET_BILLING = '1';
process.env.WALLET_ADMIN_FREE = '0';

const { openAdminDb } = await import('../lib/admin-db.mjs');
const {
  creditUserBalance,
  getUserBalanceCents,
  reserveRechargeFee,
  settleRechargeFee,
  assertCanStartRecharge,
  RECHARGE_FEE_CONFIRMED_CENTS,
  RECHARGE_FEE_UNCONFIRMED_CENTS,
} = await import('../lib/user-wallet.mjs');
const { upsertTelegramUser, getAdminDb } = await import('../lib/admin-db.mjs');

openAdminDb();
upsertTelegramUser({ id: 1 }, { incrementMessages: 0 });

let ok = 0;
function check(name, cond) {
  if (cond) {
    ok += 1;
    console.log(`✓ ${name}`);
  } else {
    console.error(`✗ ${name} (saldo=${getUserBalanceCents('1')}c)`);
    process.exitCode = 1;
  }
}

function reset(cents) {
  getAdminDb().prepare('UPDATE user_balances SET balance_cents = ? WHERE chat_id = ?').run(cents, '1');
}

// R$ 3 — uma confirmada zera; segunda tentativa falha
creditUserBalance('1', 300, { kind: 'test' });
const h1 = reserveRechargeFee('1', { refId: 'a' });
check('R$3 reserva ok', h1.ok && getUserBalanceCents('1') === 0);
check('R$3 segunda reserva bloqueada', !reserveRechargeFee('1', { refId: 'b' }).ok);
settleRechargeFee('1', { confirmed: true, refId: 'a' });
check('R$3 após confirmada', getUserBalanceCents('1') === 0);
check('R$3 assert negado', !assertCanStartRecharge('1').ok);

// R$ 3 — não confirmada → R$ 1; não dá segunda recarga
reset(300);
reserveRechargeFee('1', { refId: 'c' });
settleRechargeFee('1', { confirmed: false, refId: 'c' });
check('R$3 nok fica R$1', getUserBalanceCents('1') === 100);
check('R$1 não reserva', !reserveRechargeFee('1', { refId: 'd' }).ok);

// R$ 6 — duas confirmadas
reset(600);
reserveRechargeFee('1', { refId: 'e' });
settleRechargeFee('1', { confirmed: true, refId: 'e' });
check('R$6 após 1ª confirmada', getUserBalanceCents('1') === 300);
const h2 = reserveRechargeFee('1', { refId: 'f' });
check('R$6 2ª reserva ok', h2.ok);
settleRechargeFee('1', { confirmed: true, refId: 'f' });
check('R$6 após 2ª confirmada', getUserBalanceCents('1') === 0);

// R$ 5 — nok + confirmada
reset(500);
reserveRechargeFee('1', { refId: 'g' });
settleRechargeFee('1', { confirmed: false, refId: 'g' });
check('R$5 nok → R$3', getUserBalanceCents('1') === 300);
reserveRechargeFee('1', { refId: 'h' });
settleRechargeFee('1', { confirmed: true, refId: 'h' });
check('R$5 depois confirmada → 0', getUserBalanceCents('1') === 0);

check(
  'tarifas 300/200',
  RECHARGE_FEE_CONFIRMED_CENTS === 300 && RECHARGE_FEE_UNCONFIRMED_CENTS === 200,
);

console.log(`\n${ok} checks`);
rmSync(process.env.ADMIN_DB.replace(/admin\.db$/, ''), { recursive: true, force: true });
