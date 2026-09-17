#!/usr/bin/env node
/** Credita PIX pendentes consultando a API PushinPay (webhook off-line). */
import '../lib/load-env.mjs';
import { reconcilePixDepositFromApi } from '../lib/user-wallet.mjs';
import { getAdminDb } from '../lib/admin-db.mjs';

getAdminDb();
const rows = getAdminDb()
  .prepare(`SELECT pushin_id, chat_id, value_cents, status FROM pix_deposits WHERE status != 'paid' ORDER BY created_at DESC`)
  .all();

if (!rows.length) {
  console.log('Nenhum PIX pendente.');
  process.exit(0);
}

for (const row of rows) {
  const r = await reconcilePixDepositFromApi(row.pushin_id);
  console.log(row.pushin_id, row.chat_id, row.value_cents, JSON.stringify(r));
  await new Promise((r) => setTimeout(r, 65_000));
}
