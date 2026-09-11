import { getBotPauseState } from './admin-db.mjs';

const CACHE_MS = 1000;
let cached = { at: 0, state: null };

export const PAUSE_USER_MESSAGE =
  '⏸ Bot pausado pelo administrador. Novas recargas estão suspensas.';

export function invalidateBotPauseCache() {
  cached.at = 0;
  cached.state = null;
}

export function getBotPauseInfo() {
  if (String(process.env.BOT_PAUSED ?? '0') === '1') {
    return { paused: true, reason: 'BOT_PAUSED=1 no .env', pausedAt: null, pausedBy: 'env' };
  }
  const now = Date.now();
  if (now - cached.at < CACHE_MS && cached.state) return cached.state;
  cached.state = getBotPauseState();
  cached.at = now;
  return cached.state;
}

export function isBotPaused() {
  return Boolean(getBotPauseInfo().paused);
}

export function isPauseControlCommand(text = '') {
  return /^\/(pause|resume|pausar|retomar)(@\S+)?(\s|$)/i.test(String(text).trim());
}

export function isReadOnlyWhenPaused(text = '') {
  const t = String(text).trim();
  if (!t) return false;
  if (isPauseControlCommand(t)) return true;
  return (
    t === '/status' ||
    t.startsWith('/status@') ||
    t === '/help' ||
    t.startsWith('/help@') ||
    t === '/lista' ||
    t.startsWith('/lista@') ||
    t === '/valores' ||
    t.startsWith('/valores@') ||
    t.startsWith('/valor') ||
    t === '/cartoes_fila' ||
    t.startsWith('/cartoes_fila@') ||
    t === '/cartoes' ||
    t.startsWith('/cartoes@') ||
    t === '/erros' ||
    t.startsWith('/erros@')
  );
}

export function isRechargeCallback(data = '') {
  const d = String(data);
  if (!d) return false;
  if (d === 'recarga:start' || d === 'rcg:retry') return true;
  if (d.startsWith('rcgmode:')) return true;
  if (d.startsWith('rcgpay:')) return true;
  if (d.startsWith('rcg:') && !['rcg:cancel', 'rcg:home'].includes(d)) return true;
  if (d.startsWith('card:') || d.startsWith('rm:') || d.startsWith('cfm:')) return true;
  return false;
}
