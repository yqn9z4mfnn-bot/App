#!/usr/bin/env node
import dotenv from 'dotenv';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local/share'), 'linkclaro-bot');
dotenv.config({ path: path.join(dataDir, '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env') });

await import('./server.mjs');
