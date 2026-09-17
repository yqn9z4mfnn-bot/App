import {
  isTelegramUserAdmin,
  isTelegramUserAllowed,
  listTelegramAdmins,
  listTelegramUsers,
  listTelegramUsersPendingApproval,
  setTelegramUserAllowed,
  upsertTelegramUser,
} from './admin-db.mjs';

export function parseBootstrapAdminIds() {
  const raw = process.env.TELEGRAM_ADMIN_IDS || process.env.TELEGRAM_ADMIN_CHAT_ID || '';
  return new Set(
    String(raw)
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function applyBootstrapAdmin(chatId) {
  const ids = parseBootstrapAdminIds();
  return ids.has(String(chatId));
}

/** Registra usuário e retorna status de acesso. */
export function registerTelegramUser(from, { incrementMessages = 1 } = {}) {
  const user = upsertTelegramUser(from, { incrementMessages });
  if (!user) return { user: null, allowed: false, pending: false, admin: false };
  const admin = isTelegramUserAdmin(from.id);
  const allowed = isTelegramUserAllowed(from.id);
  const pending = !admin && !allowed && user.allowed === 0;
  return { user, allowed, pending, admin };
}

export function accessDeniedMessage(user) {
  if (user?.allowed === 0) {
    return (
      '⏳ <b>Aguardando autorização</b>\n\n' +
      'Seu acesso ainda não foi aprovado pelo administrador.\n' +
      'Quando liberarem, você recebe aviso aqui e pode usar sua própria fila de GG.'
    );
  }
  return '🚫 Acesso bloqueado pelo administrador.';
}

export function resolveUserTarget(text, replyFrom) {
  const t = String(text ?? '').trim();
  if (replyFrom?.id) return String(replyFrom.id);
  const m = t.match(/(?:@?\S+\s+)?(\d{6,20})\s*$/);
  if (m) return m[1];
  const u = t.match(/@([a-zA-Z0-9_]{4,32})/);
  if (u) return { username: u[1] };
  return null;
}

export function findUserByUsername(username) {
  const rows = listTelegramUsers({ limit: 500, offset: 0 });
  const hit = rows.find((r) => String(r.username || '').toLowerCase() === String(username).toLowerCase());
  return hit?.chat_id ?? null;
}

export async function notifyAdminsNewUser(tgSend, user) {
  if (!user || user.allowed !== 0 || user.is_admin === 1) return;
  if (Number(user.message_count) > 2) return;
  const admins = listTelegramAdmins();
  const label = user.username ? `@${user.username}` : user.first_name || user.chat_id;
  const text = [
    '🆕 <b>Novo usuário no bot</b>',
    `ID: <code>${user.chat_id}</code>`,
    `Nome: ${label}`,
    '',
    'Aprovar: <code>/aprovar ' + user.chat_id + '</code>',
    'Ver pendentes: /pendentes',
  ].join('\n');
  for (const a of admins) {
    await tgSend(a.chat_id, text).catch(() => {});
  }
  const bootstrap = parseBootstrapAdminIds();
  for (const id of bootstrap) {
    if (!admins.some((a) => String(a.chat_id) === String(id))) {
      await tgSend(id, text).catch(() => {});
    }
  }
}

export async function approveUser(chatId, tgSend) {
  setTelegramUserAllowed(chatId, true);
  await tgSend(chatId, '✅ <b>Acesso liberado!</b>\n\nUse /start — sua fila de GG é só sua; admins podem usar todas as filas.').catch(
    () => {},
  );
}

export async function denyUser(chatId, tgSend) {
  setTelegramUserAllowed(chatId, false);
  await tgSend(chatId, '🚫 Seu acesso foi negado pelo administrador.').catch(() => {});
}

export function formatPendingUsersList() {
  const rows = listTelegramUsersPendingApproval();
  if (!rows.length) return '✅ Nenhum usuário aguardando aprovação.';
  const lines = ['<b>⏳ Aguardando aprovação</b>', ''];
  for (const u of rows) {
    const label = u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(' ') || '—';
    lines.push(`• <code>${u.chat_id}</code> — ${label}`);
  }
  lines.push('', 'Aprovar: <code>/aprovar ID</code> · Negar: <code>/negar ID</code>');
  return lines.join('\n');
}

export {
  isTelegramUserAdmin,
  isTelegramUserAllowed,
  listTelegramUsersPendingApproval,
  setTelegramUserAllowed,
};
