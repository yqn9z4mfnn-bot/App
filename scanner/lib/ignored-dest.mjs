import fs from 'fs';
import path from 'path';
import { fetchClaroLoginLink, normalizeBrMobile } from './fetch-claro-link.mjs';

const DEST_LINK_ERROR_RE = /Falha ao obter link de recarga da Claro/i;

export function isDestLinkUnreachableError(err) {
  return DEST_LINK_ERROR_RE.test(String(err?.message || err || ''));
}

export class DestLinkUnreachableError extends Error {
  constructor(msisdn) {
    const number = normalizeBrMobile(msisdn) || String(msisdn ?? '').replace(/\D/g, '');
    super(`Destino ${number} ignorado — sem link de recarga Claro`);
    this.name = 'DestLinkUnreachableError';
    this.code = 'DEST_LINK_UNREACHABLE';
    this.msisdn = number;
  }
}

function ignoredDestPath() {
  const base = process.env.XDG_DATA_HOME || path.join(process.env.HOME || '/tmp', '.local/share/cloud-bot-home');
  return path.join(base, 'linkclaro-bot', 'ignored-dest-msisdns.txt');
}

export function loadIgnoredDests() {
  const file = ignoredDestPath();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return new Set(
      raw
        .split(/\n/)
        .map((line) => normalizeBrMobile(line.trim()))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

export function isIgnoredDest(msisdn) {
  const number = normalizeBrMobile(msisdn);
  if (!number) return false;
  return loadIgnoredDests().has(number);
}

export function rememberIgnoredDest(msisdn) {
  const number = normalizeBrMobile(msisdn);
  if (!number) return false;
  const known = loadIgnoredDests();
  if (known.has(number)) return false;
  const file = ignoredDestPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${number}\n`, 'utf8');
  console.log(`[dest] ignorado permanentemente: ${number}`);
  return true;
}

/** Tenta obter link JWT do destino; falha permanente da API → skip. */
export async function probeDestRechargeLink(msisdn, opts = {}) {
  const number = normalizeBrMobile(msisdn);
  if (!number) return { ok: false, error: 'destino inválido', skip: false };

  try {
    const { link } = await fetchClaroLoginLink(number, opts);
    return { ok: true, link, msisdn: number };
  } catch (err) {
    if (isDestLinkUnreachableError(err)) {
      rememberIgnoredDest(number);
      return { ok: false, msisdn: number, error: String(err.message || err), skip: true };
    }
    return { ok: false, msisdn: number, error: err.message || String(err), skip: false };
  }
}

export async function assertDestCanReceiveRecharge(msisdn, opts = {}) {
  const number = normalizeBrMobile(msisdn);
  if (!number) throw new Error('Destino inválido');
  if (isIgnoredDest(number)) throw new DestLinkUnreachableError(number);
  const probe = await probeDestRechargeLink(number, opts);
  if (probe.ok) return probe;
  if (probe.skip) throw new DestLinkUnreachableError(number);
  throw new Error(probe.error || 'Falha ao validar destino');
}
