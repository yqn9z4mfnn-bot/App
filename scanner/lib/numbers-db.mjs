import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

function defaultDbPath() {
  if (process.env.NUMBERS_DB) return process.env.NUMBERS_DB;
  return join(homedir(), '.local/share/linkclaro-bot/numbers.db');
}

let db;

export function openNumbersDb(dbPath = defaultDbPath()) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS numbers (
      msisdn TEXT PRIMARY KEY,
      link TEXT,
      valores TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      scanned_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_numbers_scanned ON numbers(scanned_at DESC);
  `);
  return database;
}

function getDb() {
  if (!db) db = openNumbersDb();
  return db;
}

function parseValores(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function mapRow(row) {
  if (!row) return null;
  return {
    msisdn: row.msisdn,
    link: row.link,
    valores: parseValores(row.valores),
    status: row.status,
    error: row.error || null,
    scannedAt: row.scanned_at,
  };
}

export function upsertNumber({ msisdn, link, valores = [], status = 'ok', error = null }) {
  getDb()
    .prepare(
      `INSERT INTO numbers (msisdn, link, valores, status, error, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(msisdn) DO UPDATE SET
         link = excluded.link,
         valores = excluded.valores,
         status = excluded.status,
         error = excluded.error,
         scanned_at = excluded.scanned_at`,
    )
    .run(
      msisdn,
      link ?? null,
      JSON.stringify(valores ?? []),
      status,
      error ?? null,
      Date.now(),
    );
}

export function getNumber(msisdn) {
  const row = getDb().prepare('SELECT * FROM numbers WHERE msisdn = ?').get(msisdn);
  return mapRow(row);
}

export function listNumbers({ limit = 20, offset = 0, onlyOk = true } = {}) {
  const lim = Math.max(1, Number(limit) || 20);
  const off = Math.max(0, Number(offset) || 0);
  const sql = onlyOk
    ? 'SELECT * FROM numbers WHERE status = ? ORDER BY scanned_at DESC LIMIT ? OFFSET ?'
    : 'SELECT * FROM numbers ORDER BY scanned_at DESC LIMIT ? OFFSET ?';
  const rows = onlyOk
    ? getDb().prepare(sql).all('ok', lim, off)
    : getDb().prepare(sql).all(lim, off);
  return rows.map(mapRow);
}

export function countNumbers({ onlyOk = true } = {}) {
  if (onlyOk) {
    return getDb().prepare("SELECT COUNT(*) AS n FROM numbers WHERE status = 'ok'").get().n;
  }
  return getDb().prepare('SELECT COUNT(*) AS n FROM numbers').get().n;
}

export function countWithValues() {
  const rows = getDb().prepare("SELECT valores FROM numbers WHERE status = 'ok'").all();
  return rows.filter((r) => parseValores(r.valores).length > 0).length;
}

export function listErrors({ limit = 20, offset = 0 } = {}) {
  const lim = Math.max(1, Number(limit) || 20);
  const off = Math.max(0, Number(offset) || 0);
  const rows = getDb()
    .prepare(
      "SELECT * FROM numbers WHERE status = 'error' ORDER BY scanned_at DESC LIMIT ? OFFSET ?",
    )
    .all(lim, off);
  return rows.map(mapRow);
}

export function countErrors() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM numbers WHERE status = 'error'").get().n;
}

export function deleteNumber(msisdn) {
  const r = getDb().prepare('DELETE FROM numbers WHERE msisdn = ?').run(msisdn);
  return r.changes > 0;
}
