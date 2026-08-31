import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getDataDir } from './data-dir.mjs';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let db;

function dbPath() {
  return process.env.ADMIN_DB || join(getDataDir(), 'admin.db');
}

function isSqliteBusy(err) {
  return (
    err?.errcode === 5 ||
    /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(err?.message || err))
  );
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withBusyRetry(fn, tries = 8) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try {
      return fn();
    } catch (err) {
      last = err;
      if (!isSqliteBusy(err) || i === tries - 1) throw err;
      sleepMs(40 * (i + 1));
    }
  }
  throw last;
}

export function openAdminDb() {
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA busy_timeout = 8000;');
    database.exec('PRAGMA synchronous = NORMAL;');
  } catch {
    // ignore
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telegram_users (
      chat_id TEXT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      allowed INTEGER NOT NULL DEFAULT 1,
      is_admin INTEGER NOT NULL DEFAULT 0,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS recharge_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      chat_id TEXT,
      username TEXT,
      login_msisdn TEXT,
      target_msisdn TEXT,
      product_name TEXT,
      product_value_cents INTEGER,
      card_last4 TEXT,
      status TEXT,
      gate_code TEXT,
      gate_message TEXT,
      mode TEXT,
      duration_ms INTEGER,
      raw_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recharge_created ON recharge_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_recharge_chat ON recharge_events(chat_id);
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      actor TEXT,
      action TEXT NOT NULL,
      entity TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
  `);
  const cols = database.prepare('PRAGMA table_info(recharge_events)').all().map((r) => r.name);
  if (!cols.includes('card_bin')) {
    database.exec('ALTER TABLE recharge_events ADD COLUMN card_bin TEXT');
  }
  return database;
}

function getDb() {
  if (!db) db = openAdminDb();
  return db;
}

export function createAdminSession() {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  return withBusyRetry(() => {
    getDb()
      .prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
      .run(token, now, now + SESSION_TTL_MS);
    return { token, expiresAt: now + SESSION_TTL_MS };
  });
}

export function validateAdminSession(token) {
  if (!token) return false;
  return withBusyRetry(() => {
    const row = getDb().prepare('SELECT expires_at FROM admin_sessions WHERE token = ?').get(token);
    if (!row) return false;
    if (row.expires_at < Date.now()) {
      getDb().prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
      return false;
    }
    return true;
  });
}

export function revokeAdminSession(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
}

export function upsertTelegramUser(from, { incrementMessages = 1 } = {}) {
  if (!from?.id) return null;
  const chatId = String(from.id);
  const now = Date.now();
  return withBusyRetry(() => {
  const existing = getDb().prepare('SELECT * FROM telegram_users WHERE chat_id = ?').get(chatId);
  if (existing) {
    getDb()
      .prepare(
        `UPDATE telegram_users SET
          username = ?, first_name = ?, last_name = ?,
          last_seen = ?, message_count = message_count + ?
         WHERE chat_id = ?`,
      )
      .run(
        from.username ?? existing.username,
        from.first_name ?? existing.first_name,
        from.last_name ?? existing.last_name,
        now,
        incrementMessages,
        chatId,
      );
  } else {
    getDb()
      .prepare(
        `INSERT INTO telegram_users
          (chat_id, username, first_name, last_name, allowed, is_admin, first_seen, last_seen, message_count)
         VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)`,
      )
      .run(
        chatId,
        from.username ?? null,
        from.first_name ?? null,
        from.last_name ?? null,
        now,
        now,
        incrementMessages,
      );
  }
  return getTelegramUser(chatId);
  });
}

export function getTelegramUser(chatId) {
  return getDb().prepare('SELECT * FROM telegram_users WHERE chat_id = ?').get(String(chatId)) ?? null;
}

export function isTelegramUserAllowed(chatId) {
  const row = getTelegramUser(chatId);
  if (!row) return true;
  return row.allowed === 1;
}

export function listTelegramUsers({ limit = 100, offset = 0 } = {}) {
  return getDb()
    .prepare('SELECT * FROM telegram_users ORDER BY last_seen DESC LIMIT ? OFFSET ?')
    .all(limit, offset);
}

export function countTelegramUsers() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM telegram_users').get().n;
}

export function setTelegramUserAllowed(chatId, allowed) {
  getDb()
    .prepare('UPDATE telegram_users SET allowed = ? WHERE chat_id = ?')
    .run(allowed ? 1 : 0, String(chatId));
}

export function insertRechargeEvent(event) {
  return withBusyRetry(() => {
  const r = getDb()
    .prepare(
      `INSERT INTO recharge_events
        (created_at, chat_id, username, login_msisdn, target_msisdn, product_name, product_value_cents,
         card_last4, card_bin, status, gate_code, gate_message, mode, duration_ms, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.createdAt ?? Date.now(),
      event.chatId ?? null,
      event.username ?? null,
      event.loginMsisdn ?? null,
      event.targetMsisdn ?? null,
      event.productName ?? null,
      event.productValueCents ?? null,
      event.cardLast4 ?? null,
      event.cardBin ?? null,
      event.status ?? null,
      event.gateCode ?? null,
      event.gateMessage ?? null,
      event.mode ?? null,
      event.durationMs ?? null,
      event.rawJson ? JSON.stringify(event.rawJson) : null,
    );
  return r.lastInsertRowid;
  });
}

export function backfillRechargeEvent(id, { status, gateCode, gateMessage, cardLast4 }) {
  return withBusyRetry(() => {
  getDb()
    .prepare(
      `UPDATE recharge_events
       SET status = COALESCE(?, status),
           gate_code = COALESCE(?, gate_code),
           gate_message = COALESCE(?, gate_message),
           card_last4 = COALESCE(?, card_last4)
       WHERE id = ?`,
    )
    .run(status ?? null, gateCode ?? null, gateMessage ?? null, cardLast4 ?? null, id);
  });
}

export function listRechargeEvents({ limit = 50, offset = 0, chatId = null } = {}) {
  return withBusyRetry(() => {
    if (chatId) {
      return getDb()
        .prepare(
          'SELECT * FROM recharge_events WHERE chat_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        )
        .all(String(chatId), limit, offset);
    }
    return getDb()
      .prepare('SELECT * FROM recharge_events ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset);
  });
}

export function countRechargeEvents() {
  return withBusyRetry(() => getDb().prepare('SELECT COUNT(*) AS n FROM recharge_events').get().n);
}

export function countRechargeEventsByStatus() {
  return withBusyRetry(() => {
    const rows = getDb()
      .prepare('SELECT status, COUNT(*) AS n FROM recharge_events GROUP BY status')
      .all();
    return Object.fromEntries(rows.map((r) => [r.status || 'unknown', r.n]));
  });
}

export function rechargeStatsSince(sinceMs) {
  return withBusyRetry(() => {
  const rows = getDb()
    .prepare(
      `SELECT status, COUNT(*) AS n FROM recharge_events
       WHERE created_at >= ? GROUP BY status`,
    )
    .all(sinceMs);
  return Object.fromEntries(rows.map((r) => [r.status || 'unknown', r.n]));
  });
}

export function insertAudit(actor, action, entity = null, detail = null) {
  getDb()
    .prepare('INSERT INTO audit_log (created_at, actor, action, entity, detail) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), actor ?? 'admin', action, entity, detail ? JSON.stringify(detail) : null);
}

export function listAudit({ limit = 100, offset = 0 } = {}) {
  return getDb()
    .prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(limit, offset);
}
