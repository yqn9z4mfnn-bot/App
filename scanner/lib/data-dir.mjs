import { join } from 'node:path';
import { homedir } from 'node:os';

export function getDataDir() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'linkclaro-bot');
}

export function getAppDir() {
  return join(getDataDir(), 'app');
}
