import fs from 'node:fs';
import path from 'node:path';

function dataDir() {
  const base = process.env.XDG_DATA_HOME || path.join(process.env.HOME || '', '.local/share/cloud-bot-home');
  return path.join(base, 'linkclaro-bot');
}

export function botHeartbeatPath() {
  return path.join(dataDir(), 'bot-heartbeat.json');
}

/** Atualiza heartbeat para o vigia detectar bot vivo (poll loop). */
export function writeBotHeartbeat(extra = {}) {
  const at = Date.now();
  const payload = {
    at,
    pid: process.pid,
    uptimeSec: Math.floor(process.uptime()),
    ...extra,
  };
  const file = botHeartbeatPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (err) {
    console.error('[bot] heartbeat write failed:', err?.message ?? err);
  }
}
