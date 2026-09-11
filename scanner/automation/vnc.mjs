import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let vncRefCount = 0;
let vncChild = null;

const vncEnabled = () => String(process.env.VNC_ON_3DS ?? '1').trim() !== '0';

const getVncPassFile = () => {
  const data =
    process.env.XDG_DATA_HOME ||
    path.join(process.env.HOME || '/root', '.local/share/linkclaro-bot');
  return path.join(data, 'vncpasswd');
};

const isXvfbRunning = () => {
  try {
    execSync('pgrep -f "Xvfb :99"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const ensureXvfb = () => {
  if (isXvfbRunning()) return;
  try {
    execSync(
      'Xvfb :99 -screen 0 980x980x24 -ac +extension GLX +render -noreset >> /tmp/xvfb.log 2>&1 &',
      { shell: '/bin/bash' },
    );
  } catch {
    // ignore
  }
};

/** Abre VNC só durante 3DS (porta 5900). Fecha quando sessão encerrar. */
export const startVncOn3ds = () => {
  if (!vncEnabled()) return;
  vncRefCount += 1;
  if (vncChild?.pid) {
    console.log(`[automation][vnc] ativo (refs=${vncRefCount})`);
    return;
  }

  const passFile = getVncPassFile();
  if (!fs.existsSync(passFile)) {
    console.warn('[automation][vnc] vncpasswd ausente — rode x11vnc -storepasswd');
    vncRefCount = Math.max(0, vncRefCount - 1);
    return;
  }

  ensureXvfb();

  const port = Number(process.env.VNC_PORT || 5900);
  const listen = process.env.VNC_LISTEN || '0.0.0.0';

  try {
    vncChild = spawn(
      'x11vnc',
      [
        '-display',
        ':99',
        '-rfbauth',
        passFile,
        '-rfbport',
        String(port),
        '-listen',
        listen,
        '-forever',
        '-shared',
        '-noxdamage',
        '-repeat',
      ],
      { detached: false, stdio: 'ignore' },
    );
    vncChild.on('exit', () => {
      vncChild = null;
    });
    console.log(`[automation][vnc] aberto ${listen}:${port} (3DS — refs=${vncRefCount})`);
  } catch (err) {
    vncRefCount = Math.max(0, vncRefCount - 1);
    console.warn('[automation][vnc] falha ao iniciar:', err?.message || err);
  }
};

/** Fecha VNC quando última sessão 3DS terminar. */
export const stopVncIfIdle = () => {
  vncRefCount = Math.max(0, vncRefCount - 1);
  if (vncRefCount > 0) return;

  try {
    if (vncChild?.pid) {
      vncChild.kill('SIGTERM');
      vncChild = null;
    }
    execSync('pkill -f "x11vnc -display :99" 2>/dev/null', { shell: '/bin/bash', stdio: 'ignore' });
    console.log('[automation][vnc] fechado');
  } catch {
    // ignore
  }
};
