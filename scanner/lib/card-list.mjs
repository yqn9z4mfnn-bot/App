import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { parseCardInput, formatCardLine } from './card-parse.mjs';

const RESERVATION_TTL_MS = Number(process.env.CARD_RESERVATION_TTL_MS || 15 * 60 * 1000);

let lock = Promise.resolve();

async function withLock(fn) {
  const prev = lock;
  let release;
  lock = new Promise((r) => {
    release = r;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function writeLines(filePath, lines) {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const body = lines.length ? `${lines.join('\n')}\n` : '';
  fs.writeFileSync(filePath, body, 'utf8');
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function createCardListStore(dataDir) {
  const pendingPath = join(dataDir, 'cards-pending.txt');
  const approvedPath = join(dataDir, 'cards-approved.txt');
  const reservedPath = join(dataDir, 'cards-reserved.json');

  const loadPending = () => readLines(pendingPath);
  const loadApproved = () => readLines(approvedPath);

  const loadReserved = () => {
    const data = readJson(reservedPath, { reservations: [] });
    return Array.isArray(data.reservations) ? data.reservations : [];
  };

  const saveReserved = (reservations) => {
    writeJson(reservedPath, { reservations });
  };

  const purgeStaleReservations = (reservations) => {
    const now = Date.now();
    const fresh = [];
    const expired = [];
    for (const r of reservations) {
      if (now - (r.reservedAt ?? 0) > RESERVATION_TTL_MS) {
        expired.push(r);
      } else {
        fresh.push(r);
      }
    }
    return { fresh, expired };
  };

  const pansInUse = (reservations) =>
    new Set(reservations.map((r) => r.pan).filter(Boolean));

  const countPending = () => loadPending().length;
  const countApproved = () => loadApproved().length;
  const countInUse = () => loadReserved().length;

  const peekPendingLine = () => loadPending()[0] ?? null;

  const getReservationForPan = (pan, chatId = null) => {
    const key = String(pan ?? '').replace(/\D/g, '');
    if (!key) return null;
    const { fresh } = purgeStaleReservations(loadReserved());
    return (
      fresh.find((r) => r.pan === key && (chatId == null || r.chatId === chatId)) ?? null
    );
  };

  /** Bloqueia uso do mesmo PAN por outro chat (manual ou automático). */
  const assertCardAvailable = (cardOrLine, chatId) => {
    const pan =
      typeof cardOrLine === 'string'
        ? normalizeCardKey(cardOrLine)
        : String(cardOrLine?.number ?? '').replace(/\D/g, '');
    if (!pan) return { ok: true };

    let reservations = loadReserved();
    const purged = purgeStaleReservations(reservations);
    if (purged.expired.length) {
      const pending = loadPending();
      for (const exp of purged.expired) {
        if (exp.line && !pending.some((l) => normalizeCardKey(l) === exp.pan)) {
          pending.unshift(exp.line);
        }
      }
      writeLines(pendingPath, pending);
      reservations = purged.fresh;
      saveReserved(reservations);
    }

    const hit = reservations.find((r) => r.pan === pan);
    if (hit && hit.chatId !== chatId) {
      return {
        ok: false,
        reason: `Cartão ****${pan.slice(-4)} em uso por outra sessão (desde ${new Date(hit.reservedAt).toLocaleTimeString('pt-BR')})`,
      };
    }
    return { ok: true };
  };

  /**
   * Reserva atomicamente o próximo cartão disponível — sai da fila até concluir a recarga.
   * Impede que dois usuários peguem o mesmo cartão.
   */
  const reserveNextCard = (chatId) =>
    withLock(() => {
      let reservations = loadReserved();
      const purged = purgeStaleReservations(reservations);
      reservations = purged.fresh;
      if (purged.expired.length) {
        const pending = loadPending();
        for (const exp of purged.expired) {
          if (exp.line && !pending.some((l) => normalizeCardKey(l) === exp.pan)) {
            pending.unshift(exp.line);
          }
        }
        writeLines(pendingPath, pending);
      }

      const inUse = pansInUse(reservations);
      const pending = loadPending();
      let pickedIdx = -1;
      let pickedLine = null;
      let pickedPan = null;

      for (let i = 0; i < pending.length; i += 1) {
        const line = pending[i];
        const card = parseCardInput(line);
        if (!card) continue;
        const pan = card.number.replace(/\D/g, '');
        if (inUse.has(pan)) continue;
        pickedIdx = i;
        pickedLine = line;
        pickedPan = pan;
        break;
      }

      if (pickedIdx < 0 || !pickedLine) {
        saveReserved(reservations);
        return null;
      }

      const rest = pending.filter((_, i) => i !== pickedIdx);
      writeLines(pendingPath, rest);

      reservations.push({
        line: pickedLine,
        pan: pickedPan,
        chatId,
        reservedAt: Date.now(),
      });
      saveReserved(reservations);

      return {
        line: pickedLine,
        card: parseCardInput(pickedLine),
        pan: pickedPan,
      };
    });

  const shiftPendingLine = () =>
    withLock(() => {
      const lines = loadPending();
      if (!lines.length) return null;
      const [first, ...rest] = lines;
      writeLines(pendingPath, rest);
      return first;
    });

  const appendPendingLines = (newLines) =>
    withLock(() => {
      const reservations = loadReserved();
      const inUse = pansInUse(purgeStaleReservations(reservations).fresh);
      const existing = new Set([
        ...loadPending().map(normalizeCardKey).filter(Boolean),
        ...inUse,
      ]);
      const merged = loadPending();
      let added = 0;
      for (const raw of newLines) {
        const line = String(raw ?? '').trim();
        if (!line || line.startsWith('#')) continue;
        const key = normalizeCardKey(line);
        if (!key || existing.has(key)) continue;
        existing.add(key);
        merged.push(line);
        added += 1;
      }
      writeLines(pendingPath, merged);
      return { added, total: merged.length, inUse: inUse.size };
    });

  const ingestText = (text) => {
    const lines = String(text ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    return appendPendingLines(lines);
  };

  const reserveAdHocCard = (chatId, card) =>
    withLock(() => {
      const pan = String(card?.number ?? '').replace(/\D/g, '');
      if (!pan) return null;

      let reservations = loadReserved();
      const purged = purgeStaleReservations(reservations);
      reservations = purged.fresh;

      const hit = reservations.find((r) => r.pan === pan);
      if (hit && hit.chatId !== chatId) return null;

      const line = formatCardLine(card);
      if (!hit) {
        reservations.push({
          line,
          pan,
          chatId,
          reservedAt: Date.now(),
          adHoc: true,
        });
        saveReserved(reservations);
      }
      return { line, pan };
    });

  const applyOutcome = (line, action, meta = '', chatId = null) =>
    withLock(() => {
      if (!line) {
        return { action, pendingLeft: loadPending().length, inUse: countInUse() };
      }

      const pan = normalizeCardKey(line);
      let reservations = loadReserved();
      const resIdx = reservations.findIndex(
        (r) => r.line === line || (pan && r.pan === pan && (chatId == null || r.chatId === chatId)),
      );

      if (resIdx >= 0) {
        const [removedRes] = reservations.splice(resIdx, 1);
        saveReserved(reservations);

        if (action === 'return') {
          const pending = loadPending();
          if (!pending.some((l) => normalizeCardKey(l) === removedRes.pan)) {
            pending.unshift(removedRes.line);
            writeLines(pendingPath, pending);
          }
          return { action, pendingLeft: pending.length, inUse: reservations.length, returned: true };
        }

        if (action === 'approved') {
          const approved = loadApproved();
          approved.push(meta ? `${removedRes.line} # ${meta}` : removedRes.line);
          writeLines(approvedPath, approved);
        }

        return {
          action,
          pendingLeft: loadPending().length,
          inUse: reservations.length,
          removed: removedRes.line,
        };
      }

      // Fallback: cartão manual ou legado sem reserva
      const pending = loadPending();
      const idx = pending.findIndex(
        (l) => l === line || normalizeCardKey(l) === normalizeCardKey(line),
      );

      if (action === 'return') {
        return { action, pendingLeft: pending.length, inUse: reservations.length };
      }

      if (idx < 0) {
        if (action === 'approved') {
          const approved = loadApproved();
          approved.push(meta ? `${line} # ${meta}` : line);
          writeLines(approvedPath, approved);
        }
        return { action, pendingLeft: pending.length, inUse: reservations.length, warning: 'sem reserva' };
      }

      const [removed] = pending.splice(idx, 1);
      writeLines(pendingPath, pending);

      if (action === 'approved') {
        const approved = loadApproved();
        approved.push(meta ? `${removed} # ${meta}` : removed);
        writeLines(approvedPath, approved);
      }

      return {
        action,
        pendingLeft: pending.length,
        inUse: reservations.length,
        removed,
      };
    });

  return {
    pendingPath,
    approvedPath,
    reservedPath,
    loadPending,
    loadApproved,
    countPending,
    countApproved,
    countInUse,
    peekPendingLine,
    shiftPendingLine,
    appendPendingLines,
    ingestText,
    applyOutcome,
    reserveNextCard,
    reserveAdHocCard,
    assertCardAvailable,
    getReservationForPan,
    withLock,
  };
}

export function normalizeCardKey(line) {
  const card = parseCardInput(String(line ?? '').replace(/\s+#.*$/, ''));
  if (!card?.number) return null;
  return card.number.replace(/\D/g, '');
}

export function looksLikeCardLine(line) {
  const t = String(line ?? '').trim().replace(/\s+#.*$/, '');
  if (!t || t.startsWith('#')) return false;
  const pan = t.split(/[|;]/)[0]?.replace(/\D/g, '') ?? '';
  return pan.length >= 13 && pan.length <= 19;
}

export function looksLikeCardsTxt(text) {
  for (const line of String(text ?? '').split(/\r?\n/).slice(0, 8)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (looksLikeCardLine(t)) return true;
    const digits = t.replace(/\D/g, '');
    if (digits.length === 11 || digits.length === 10) return false;
  }
  return false;
}
