#!/usr/bin/env node
/** Isolamento de filas por chat_id (admin não rouba pending de outros). */
import fs from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCardListRouter } from '../lib/card-list-router.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'card-router-'));
const adminId = '926709483';
const userB = '8429211444';

function writePending(ownerId, line) {
  const dir = join(dataDir, 'cards-users', ownerId);
  fs.mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cards-pending.txt'), `${line}\n`, 'utf8');
}

writePending(userB, '4111111111111111|12|2030|123');
writePending(adminId, '4222222222222222|12|2030|456');

const router = createCardListRouter(dataDir, {
  isAdmin: (id) => String(id) === adminId,
  listKnownUserIds: () => [adminId, userB],
});

const picked = await router.reserveNextCard(adminId);
if (!picked?.line?.startsWith('4222')) {
  throw new Error(`admin deveria pegar só sua fila, veio: ${picked?.line}`);
}
if (picked.cardOwnerId !== adminId) {
  throw new Error(`cardOwnerId errado: ${picked.cardOwnerId}`);
}

const userPick = await router.reserveNextCard(userB);
if (!userPick?.line?.startsWith('4111')) {
  throw new Error(`user B deveria pegar sua linha, veio: ${userPick?.line}`);
}

console.log('test-card-list-router: OK');
