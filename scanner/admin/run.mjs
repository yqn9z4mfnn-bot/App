#!/usr/bin/env node
import '../lib/load-env.mjs';
import { join } from 'node:path';
import { getDataDir } from '../lib/data-dir.mjs';

if (!process.env.NUMBERS_DB) {
  process.env.NUMBERS_DB = join(getDataDir(), 'numbers.db');
}
if (!process.env.ADMIN_DB) {
  process.env.ADMIN_DB = join(getDataDir(), 'admin.db');
}

process.on('uncaughtException', (err) => {
  console.error('[admin] uncaughtException:', err?.message || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[admin] unhandledRejection:', err?.message || err);
});

const { startAdminServer } = await import('./server.mjs');
startAdminServer();
