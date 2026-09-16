import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'linkclaro-bot');
const envPath = join(dataDir, '.env');

if (existsSync(envPath)) {
  dotenv.config({ path: envPath, override: false });
}
