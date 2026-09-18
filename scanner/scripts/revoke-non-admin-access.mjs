#!/usr/bin/env node
/**
 * Aplica migração: não-admins precisam de /aprovar (revoga allowed=1 legado).
 * Normalmente roda automaticamente ao abrir admin.db (openAdminDb).
 */
import { openAdminDb, listTelegramUsers, getBotSetting } from '../lib/admin-db.mjs';

const db = openAdminDb();
const flag = getBotSetting('non_admin_require_approval_v1');
const users = listTelegramUsers({ limit: 500, offset: 0 });
const pending = users.filter((u) => u.is_admin !== 1 && u.allowed === 0);
const admins = users.filter((u) => u.is_admin === 1);
const allowedNonAdmin = users.filter((u) => u.is_admin !== 1 && u.allowed === 1);

console.log('non_admin_require_approval_v1:', flag);
console.log('admins:', admins.map((u) => `${u.chat_id} @${u.username || '—'}`).join('; ') || '—');
console.log('still allowed (non-admin):', allowedNonAdmin.length ? allowedNonAdmin.map((u) => u.chat_id).join(', ') : 'none');
console.log('pending approval:', pending.length);
for (const u of pending) {
  const label = u.username ? `@${u.username}` : u.first_name || '—';
  console.log(`  ${u.chat_id} ${label}`);
}
db.close?.();
