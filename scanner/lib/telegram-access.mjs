import {
  isTelegramUserAdmin,
  isTelegramUserAllowed,
  listTelegramAdmins,
  listTelegramUsers,
  listTelegramUsersPendingApproval,
  setTelegramUserAllowed,
  upsertTelegramUser,
  getBotSetting,
  setBotSetting,
} from './admin-db.mjs';

const ACCESS_NOTIFY_COOLDOWN_MS = 15 * 60 * 1000;
const ACCESS_NOTIFY_START_COOLDOWN_MS = 2 * 60 * 1000;

function accessNotifySettingKey(chatId) {
  return `access_pending_notify:${String(chatId)}`;
}

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

/** Avisa admins que alguém está aguardando /aprovar (inclui usuários legados após revogação). */
export async function notifyAdminsPendingAccess(tgSend, user, { reason = 'message' } = {}) {
  if (!user || user.allowed !== 0 || user.is_admin === 1) return;
  const cooldown =
    reason === 'start' ? ACCESS_NOTIFY_START_COOLDOWN_MS : ACCESS_NOTIFY_COOLDOWN_MS;
  const key = accessNotifySettingKey(user.chat_id);
  const last = Number(getBotSetting(key) || 0);
  if (last && Date.now() - last < cooldown) return;
  setBotSetting(key, String(Date.now()));

  const admins = listTelegramAdmins();
  const label = user.username ? `@${user.username}` : user.first_name || user.chat_id;
  const isNew = Number(user.message_count) <= 3;
  const headline = isNew ? '🆕 <b>Novo usuário no bot</b>' : '⏳ <b>Usuário pediu acesso</b>';
  const text = [
    headline,
    `ID: <code>${user.chat_id}</code>`,
    `Nome: ${label}`,
    reason === 'start' ? '(enviou /start)' : '',
    '',
    'Aprovar: <code>/aprovar ' + user.chat_id + '</code>',
    'Ver pendentes: /pendentes',
  ]
    .filter(Boolean)
    .join('\n');
  for (const a of admins) {
    await tgSend(a.chat_id, text).catch(() => {});
  }
  const bootstrap = parseBootstrapAdminIds();
  for (const id of bootstrap) {
    if (!admins.some((x) => String(x.chat_id) === String(id))) {
      await tgSend(id, text).catch(() => {});
    }
  }
}

/** @deprecated use notifyAdminsPendingAccess */
export async function notifyAdminsNewUser(tgSend, user, opts) {
  return notifyAdminsPendingAccess(tgSend, user, opts);
}

export async function approveUser(chatId, tgSend) {
  setTelegramUserAllowed(chatId, true);
  setBotSetting(accessNotifySettingKey(chatId), '');
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
