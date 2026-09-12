import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isDestLinkUnreachableError,
  DestLinkUnreachableError,
  loadIgnoredDests,
  rememberIgnoredDest,
  isIgnoredDest,
} from '../lib/ignored-dest.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ignored-dest-'));
process.env.XDG_DATA_HOME = tmp;

assert.equal(isDestLinkUnreachableError(new Error('Falha ao obter link de recarga da Claro')), true);
assert.equal(isDestLinkUnreachableError(new Error('timeout')), false);

const err = new DestLinkUnreachableError('81982973854');
assert.match(err.message, /81982973854/);
assert.equal(err.code, 'DEST_LINK_UNREACHABLE');

assert.equal(isIgnoredDest('81982973854'), false);
rememberIgnoredDest('81982973854');
assert.equal(isIgnoredDest('81982973854'), true);
assert.equal(loadIgnoredDests().has('81982973854'), true);

console.log('test-ignored-dest OK');
