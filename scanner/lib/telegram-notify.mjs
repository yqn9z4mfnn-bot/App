import './load-env.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function adminDbPath() {
  return process.env.ADMIN_DB || join(homedir(), '.local/share/linkclaro-bot/admin.db');
}

/** Chat IDs para alertas — env ou usuários allowed/admin no admin.db. */
export function resolveNotifyChatIds() {
  const raw = process.env.AUTO_INGEST_NOTIFY_CHAT_IDS || process.env.BOT_ADMIN_IDS || '';
  const fromEnv = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;

  try {
    const db = new DatabaseSync(adminDbPath(), { readonly: true });
    const rows = db
      .prepare(
        `SELECT chat_id FROM telegram_users
         WHERE is_admin = 1 OR allowed = 1
         ORDER BY last_seen DESC`,
      )
      .all();
    return [...new Set(rows.map((r) => String(r.chat_id)).filter(Boolean))];
  } catch {
    return [];
  }
}

export async function sendTelegramNotify(text, { chatIds = null } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ids = chatIds ?? resolveNotifyChatIds();
  if (!token) {
    console.warn('[notify] TELEGRAM_BOT_TOKEN ausente — skip');
    return false;
  }
  if (!ids.length) {
    console.warn('[notify] nenhum chat_id (AUTO_INGEST_NOTIFY_CHAT_IDS ou admin.db) — skip');
    return false;
  }

  let ok = true;
  for (const chatId of ids) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      const body = await res.json();
      if (!body.ok) {
        console.warn(`[notify] falha chat ${chatId}: ${body.description || res.status}`);
        ok = false;
      }
    } catch (err) {
      console.warn(`[notify] erro chat ${chatId}: ${err?.message || err}`);
      ok = false;
    }
  }
  return ok;
}
