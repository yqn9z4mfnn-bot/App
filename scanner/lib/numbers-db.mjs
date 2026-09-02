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
    CREATE TABLE IF NOT EXISTS number_values (
      msisdn TEXT NOT NULL,
      value_cents INTEGER NOT NULL,
      product_id TEXT,
      name TEXT,
      PRIMARY KEY (msisdn, value_cents)
    );
    CREATE INDEX IF NOT EXISTS idx_nv_value ON number_values(value_cents);
  `);
  rebuildValueIndex(database);
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

function replaceValues(database, msisdn, valores) {
  database.prepare('DELETE FROM number_values WHERE msisdn = ?').run(msisdn);
  if (!valores?.length) return;
  const ins = database.prepare(
    `INSERT OR REPLACE INTO number_values (msisdn, value_cents, product_id, name)
     VALUES (?, ?, ?, ?)`,
  );
  for (const v of valores) {
    const cents = Number(v?.value);
    if (!Number.isFinite(cents) || cents <= 0) continue;
    ins.run(msisdn, cents, v.id ?? null, v.name ?? null);
  }
}

function rebuildValueIndex(database) {
  database.exec('DELETE FROM number_values');
  const rows = database
    .prepare("SELECT msisdn, valores FROM numbers WHERE status = 'ok' AND link IS NOT NULL")
    .all();
  for (const row of rows) {
    replaceValues(database, row.msisdn, parseValores(row.valores));
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
  const database = getDb();
  database
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
  if (status === 'ok' && link) {
    replaceValues(database, msisdn, valores);
  } else {
    database.prepare('DELETE FROM number_values WHERE msisdn = ?').run(msisdn);
  }
}

export function listOkMsisdns() {
  return new Set(
    getDb()
      .prepare(
        `SELECT DISTINCT n.msisdn
         FROM numbers n
         INNER JOIN number_values nv ON nv.msisdn = n.msisdn
         WHERE n.status = 'ok' AND n.link IS NOT NULL`,
      )
      .all()
      .map((r) => r.msisdn),
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
    ? `SELECT * FROM numbers
       WHERE status IN ('ok', 'sem_valor') AND link IS NOT NULL
       ORDER BY scanned_at DESC LIMIT ? OFFSET ?`
    : 'SELECT * FROM numbers ORDER BY scanned_at DESC LIMIT ? OFFSET ?';
  const rows = onlyOk
    ? getDb().prepare(sql).all(lim, off)
    : getDb().prepare(sql).all(lim, off);
  return rows.map(mapRow);
}

export function countNumbers({ onlyOk = true } = {}) {
  if (onlyOk) {
    return getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM numbers
         WHERE status IN ('ok', 'sem_valor') AND link IS NOT NULL`,
      )
      .get().n;
  }
  return getDb().prepare('SELECT COUNT(*) AS n FROM numbers').get().n;
}

export function countWithValues() {
  return getDb().prepare('SELECT COUNT(DISTINCT msisdn) AS n FROM number_values').get().n;
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

export function deleteNumber(msisdn) {
  const database = getDb();
  database.prepare('DELETE FROM number_values WHERE msisdn = ?').run(msisdn);
  const r = database.prepare('DELETE FROM numbers WHERE msisdn = ?').run(msisdn);
  return r.changes > 0;
}

/** Converte "20", "R$ 20", "15,00" em centavos. */
export function parseReaisToCents(text) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 12) return null;
  const m = raw.match(/^(?:r\$\s*)?(\d{1,4})(?:[.,](\d{1,2}))?$/i);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = m[2] ? Number(m[2].padEnd(2, '0').slice(0, 2)) : 0;
  const cents = whole * 100 + frac;
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return cents;
}

export function listValueStock() {
  return getDb()
    .prepare(
      `SELECT value_cents, MIN(name) AS name, COUNT(*) AS n
       FROM number_values
       GROUP BY value_cents
       ORDER BY value_cents`,
    )
    .all()
    .map((r) => ({
      value: r.value_cents,
      name: r.name,
      count: r.n,
    }));
}

export function countForValue(valueCents) {
  const cents = Number(valueCents);
  if (!Number.isFinite(cents)) return 0;
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM number_values WHERE value_cents = ?')
    .get(cents).n;
}

/** DDDs distintos no banco — só molde (não exige link/estoque). */
export function listDistinctDdds() {
  return getDb()
    .prepare(
      `SELECT DISTINCT substr(msisdn, 1, 2) AS ddd
       FROM numbers
       WHERE length(msisdn) = 11
       ORDER BY ddd`,
    )
    .all()
    .map((r) => r.ddd)
    .filter(Boolean);
}

/** Número aleatório do DDD — só para copiar os 5 dígitos após o DDD. */
export function pickRandomMsisdnByDdd(ddd) {
  const d = String(ddd ?? '').replace(/\D/g, '').slice(0, 2);
  if (!d) return null;
  const row = getDb()
    .prepare(
      `SELECT msisdn FROM numbers
       WHERE msisdn LIKE ? AND length(msisdn) = 11
       ORDER BY RANDOM() LIMIT 1`,
    )
    .get(`${d}%`);
  return row?.msisdn ?? null;
}

/** Login aleatório já salvo no banco (status ok + link JWT/URL). */
export function pickRandomStoredLogin({ excludeMsisdns = [] } = {}) {
  const exclude = [
    ...new Set(
      (excludeMsisdns || [])
        .map((n) => String(n ?? '').replace(/\D/g, ''))
        .filter(Boolean),
    ),
  ];
  const row = exclude.length
    ? getDb()
        .prepare(
          `SELECT msisdn, link FROM numbers
           WHERE status = 'ok'
             AND link IS NOT NULL
             AND msisdn NOT IN (${exclude.map(() => '?').join(', ')})
           ORDER BY RANDOM() LIMIT 1`,
        )
        .get(...exclude)
    : getDb()
        .prepare(
          `SELECT msisdn, link FROM numbers
           WHERE status = 'ok' AND link IS NOT NULL
           ORDER BY RANDOM() LIMIT 1`,
        )
        .get();
  if (!row?.msisdn || !row?.link) return null;
  return { msisdn: row.msisdn, link: row.link };
}

export function pickLinkForValue(valueCents, { excludeMsisdn, excludeMsisdns } = {}) {
  const cents = Number(valueCents);
  if (!Number.isFinite(cents) || cents <= 0) return null;
  const exclude = [
    ...new Set(
      [excludeMsisdn, ...(excludeMsisdns || [])]
        .map((n) => String(n ?? '').replace(/\D/g, ''))
        .filter(Boolean),
    ),
  ];
  const row = exclude.length
    ? getDb()
        .prepare(
          `SELECT n.msisdn, n.link, nv.name, nv.product_id, nv.value_cents
           FROM number_values nv
           JOIN numbers n ON n.msisdn = nv.msisdn
           WHERE nv.value_cents = ?
             AND n.status = 'ok'
             AND n.link IS NOT NULL
             AND n.msisdn NOT IN (${exclude.map(() => '?').join(', ')})
           ORDER BY n.scanned_at ASC
           LIMIT 1`,
        )
        .get(cents, ...exclude)
    : getDb()
        .prepare(
          `SELECT n.msisdn, n.link, nv.name, nv.product_id, nv.value_cents
           FROM number_values nv
           JOIN numbers n ON n.msisdn = nv.msisdn
           WHERE nv.value_cents = ?
             AND n.status = 'ok'
             AND n.link IS NOT NULL
           ORDER BY n.scanned_at ASC
           LIMIT 1`,
        )
        .get(cents);
  if (!row) return null;
  return {
    msisdn: row.msisdn,
    link: row.link,
    name: row.name,
    productId: row.product_id,
    value: row.value_cents,
    remaining: countForValue(cents),
  };
}
