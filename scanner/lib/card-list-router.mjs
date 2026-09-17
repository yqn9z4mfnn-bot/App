import fs from 'node:fs';
import { join } from 'node:path';
import { createCardListStore } from './card-list.mjs';

const GLOBAL_OWNER = '_global';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function moveFileIfExists(from, to) {
  if (!fs.existsSync(from)) return false;
  ensureDir(join(to, '..'));
  try {
    fs.renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/** Move fila legada (cards-*.txt na raiz) para o primeiro admin bootstrap. */
export function migrateLegacyCardFiles(dataDir, targetOwnerId) {
  if (!targetOwnerId) return { migrated: false };
  const userDir = join(dataDir, 'cards-users', String(targetOwnerId));
  const names = ['cards-pending.txt', 'cards-approved.txt', 'cards-consumed.txt', 'cards-reserved.json'];
  let any = false;
  for (const name of names) {
    const root = join(dataDir, name);
    const dest = join(userDir, name);
    if (fs.existsSync(root) && !fs.existsSync(dest)) {
      if (moveFileIfExists(root, dest)) any = true;
    } else if (fs.existsSync(root) && name === 'cards-pending.txt') {
      const pending = fs.readFileSync(root, 'utf8').trim();
      if (pending) {
        ensureDir(userDir);
        fs.appendFileSync(dest, pending.endsWith('\n') ? pending : `${pending}\n`, 'utf8');
        fs.writeFileSync(root, '', 'utf8');
        any = true;
      }
    }
  }
  return { migrated: any, ownerId: String(targetOwnerId) };
}

export function createCardListRouter(dataDir, { isAdmin = () => false, listKnownUserIds = () => [] } = {}) {
  const userRoot = join(dataDir, 'cards-users');
  const globalStore = createCardListStore(dataDir);

  ensureDir(userRoot);

  function ownerStore(ownerId) {
    const id = String(ownerId);
    const dir = id === GLOBAL_OWNER ? dataDir : join(userRoot, id);
    ensureDir(dir);
    return id === GLOBAL_OWNER ? globalStore : createCardListStore(dir);
  }

  function listOwnerIds() {
    const ids = new Set();
    for (const id of listKnownUserIds()) {
      if (id != null && String(id)) ids.add(String(id));
    }
    if (fs.existsSync(userRoot)) {
      for (const name of fs.readdirSync(userRoot)) {
        if (name && !name.startsWith('.')) ids.add(name);
      }
    }
    if (globalStore.countPending() > 0 || globalStore.countInUse() > 0) {
      ids.add(GLOBAL_OWNER);
    }
    return [...ids];
  }

  function reservationOwnersForConsumer(consumerChatId) {
    if (isAdmin(consumerChatId)) return listOwnerIds();
    return [String(consumerChatId)];
  }

  function resolveOwnerForOutcome(consumerChatId, cardOwnerId) {
    if (cardOwnerId) return String(cardOwnerId);
    return String(consumerChatId);
  }

  async function reserveNextCard(consumerChatId, opts = {}) {
    const owners = reservationOwnersForConsumer(consumerChatId);
    for (const ownerId of owners.sort()) {
      const store = ownerStore(ownerId);
      const picked = await store.reserveNextCard(consumerChatId, opts);
      if (picked?.card) {
        return { ...picked, cardOwnerId: ownerId };
      }
    }
    return null;
  }

  async function ingestText(consumerChatId, text) {
    const ownerId = String(consumerChatId);
    return ownerStore(ownerId).ingestText(text);
  }

  function countsFor(consumerChatId) {
    const isAdm = isAdmin(consumerChatId);
    if (!isAdm) {
      const s = ownerStore(consumerChatId);
      return {
        pending: s.countPending(),
        approved: s.countApproved(),
        consumed: s.countConsumed(),
        inUse: s.countInUse(),
        scope: 'own',
      };
    }
    let pending = 0;
    let approved = 0;
    let consumed = 0;
    let inUse = 0;
    for (const ownerId of listOwnerIds()) {
      const s = ownerStore(ownerId);
      pending += s.countPending();
      approved += s.countApproved();
      consumed += s.countConsumed();
      inUse += s.countInUse();
    }
    return { pending, approved, consumed, inUse, scope: 'all' };
  }

  function countPending(consumerChatId) {
    return countsFor(consumerChatId).pending;
  }

  function countApproved(consumerChatId) {
    return countsFor(consumerChatId).approved;
  }

  function countConsumed(consumerChatId) {
    return countsFor(consumerChatId).consumed;
  }

  function countInUse(consumerChatId) {
    return countsFor(consumerChatId).inUse;
  }

  function peekPendingLine(consumerChatId) {
    if (isAdmin(consumerChatId)) {
      for (const ownerId of listOwnerIds().sort()) {
        const line = ownerStore(ownerId).peekPendingLine();
        if (line) return line;
      }
      return null;
    }
    return ownerStore(consumerChatId).peekPendingLine();
  }

  function assertCardAvailable(cardOrLine, consumerChatId) {
    if (isAdmin(consumerChatId)) {
      for (const ownerId of listOwnerIds()) {
        const check = ownerStore(ownerId).assertCardAvailable(cardOrLine, consumerChatId);
        if (!check.ok) return check;
      }
      return { ok: true };
    }
    return ownerStore(consumerChatId).assertCardAvailable(cardOrLine, consumerChatId);
  }

  async function reserveAdHocCard(consumerChatId, card) {
    return ownerStore(consumerChatId).reserveAdHocCard(consumerChatId, card);
  }

  async function applyOutcome(line, action, meta, consumerChatId, cardOwnerId = null) {
    const ownerId = resolveOwnerForOutcome(consumerChatId, cardOwnerId);
    return ownerStore(ownerId).applyOutcome(line, action, meta, consumerChatId);
  }

  async function releaseAllReservations() {
    let released = 0;
    let pendingLeft = 0;
    for (const ownerId of listOwnerIds()) {
      const r = await ownerStore(ownerId).releaseAllReservations();
      released += r.released ?? 0;
      pendingLeft += r.pendingLeft ?? 0;
    }
    const r0 = await globalStore.releaseAllReservations();
    released += r0.released ?? 0;
    pendingLeft += r0.pendingLeft ?? 0;
    return { released, pendingLeft };
  }

  async function releaseChatReservations(consumerChatId) {
    let released = 0;
    for (const ownerId of listOwnerIds()) {
      const r = await ownerStore(ownerId).releaseChatReservations(consumerChatId);
      released += r.released ?? 0;
    }
    return { released };
  }

  /** Painel web: ingest na fila global (admin vê no pool agregado). */
  async function ingestTextGlobal(text) {
    return globalStore.ingestText(text);
  }

  function aggregateForAdmin({ limit = 80 } = {}) {
    const pending = [];
    const approved = [];
    let inUse = 0;
    for (const ownerId of listOwnerIds().sort()) {
      const s = ownerStore(ownerId);
      for (const line of s.loadPending()) {
        pending.push({ ownerId, line });
      }
      for (const line of s.loadApproved()) {
        approved.push({ ownerId, line });
      }
      inUse += s.countInUse();
    }
    return {
      pending,
      approved,
      inUse,
      counts: {
        pending: pending.length,
        approved: approved.length,
        inUse,
        pendingShown: Math.min(limit, pending.length),
        approvedShown: Math.min(limit, approved.length),
      },
    };
  }

  function clearAllPending() {
    for (const ownerId of listOwnerIds()) {
      fs.writeFileSync(ownerStore(ownerId).pendingPath, '', 'utf8');
    }
    fs.writeFileSync(globalStore.pendingPath, '', 'utf8');
  }

  return {
    userRoot,
    globalStore,
    clearAllPending,
    ownerStore,
    listOwnerIds,
    reserveNextCard,
    ingestText,
    ingestTextGlobal,
    countsFor,
    countPending,
    countApproved,
    countConsumed,
    countInUse,
    peekPendingLine,
    assertCardAvailable,
    reserveAdHocCard,
    applyOutcome,
    releaseAllReservations,
    releaseChatReservations,
    aggregateForAdmin,
    migrateLegacyCardFiles: (targetOwnerId) => migrateLegacyCardFiles(dataDir, targetOwnerId),
  };
}
