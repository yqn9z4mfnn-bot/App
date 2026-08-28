import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { parseCardInput } from './card-parse.mjs';

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

export function createCardListStore(dataDir) {
  const pendingPath = join(dataDir, 'cards-pending.txt');
  const approvedPath = join(dataDir, 'cards-approved.txt');

  const loadPending = () => readLines(pendingPath);
  const loadApproved = () => readLines(approvedPath);

  const countPending = () => loadPending().length;
  const countApproved = () => loadApproved().length;

  const peekPendingLine = () => {
    const lines = loadPending();
    return lines[0] ?? null;
  };

  const shiftPendingLine = () =>
    withLock(() => {
      const lines = loadPending();
      if (!lines.length) return null;
      const [first, ...rest] = lines;
      writeLines(pendingPath, rest);
      return first;
    });

  const appendApprovedLine = (line, meta = '') =>
    withLock(() => {
      const lines = loadApproved();
      const entry = meta ? `${line} # ${meta}` : line;
      lines.push(entry);
      writeLines(approvedPath, lines);
    });

  const appendPendingLines = (newLines) =>
    withLock(() => {
      const existing = new Set(loadPending().map(normalizeCardKey).filter(Boolean));
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
      return { added, total: merged.length };
    });

  const ingestText = (text) => {
    const lines = String(text ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    return appendPendingLines(lines);
  };

  const applyOutcome = (line, action, meta = '') =>
    withLock(() => {
      if (!line) return { action, pendingLeft: loadPending().length };

      const pending = loadPending();
      const idx = pending.findIndex(
        (l) => l === line || normalizeCardKey(l) === normalizeCardKey(line),
      );

      if (action === 'return') {
        return { action, pendingLeft: pending.length };
      }

      if (idx < 0) {
        if (action === 'approved') {
          const approved = loadApproved();
          approved.push(meta ? `${line} # ${meta}` : line);
          writeLines(approvedPath, approved);
        }
        return { action, pendingLeft: pending.length, warning: 'linha não estava na fila' };
      }

      const [removed] = pending.splice(idx, 1);
      writeLines(pendingPath, pending);

      if (action === 'approved') {
        const approved = loadApproved();
        approved.push(meta ? `${removed} # ${meta}` : removed);
        writeLines(approvedPath, approved);
      }

      return { action, pendingLeft: pending.length, removed };
    });

  return {
    pendingPath,
    approvedPath,
    loadPending,
    loadApproved,
    countPending,
    countApproved,
    peekPendingLine,
    shiftPendingLine,
    appendApprovedLine,
    appendPendingLines,
    ingestText,
    applyOutcome,
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
