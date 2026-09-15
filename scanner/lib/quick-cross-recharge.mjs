import { normalizeBrMobile } from './fetch-claro-link.mjs';
import { parseReaisToCents } from './numbers-db.mjs';

const CLARO_RE = /^(claro|clarorecarga)$/i;

/**
 * Atalho colado no chat: 13991019331|Claro|30
 * → destino + operadora Claro + valor em reais.
 */
export function parseQuickCrossRecharge(text) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.startsWith('/')) return null;
  if (!raw.includes('|') && !raw.includes(';')) return null;

  const parts = raw.split(/[|;]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 3) return null;
  if (!CLARO_RE.test(parts[1].replace(/\s+/g, ''))) return null;

  const target = normalizeBrMobile(parts[0]);
  if (!target) return null;

  const valueCents = parseReaisToCents(parts[2].replace(/\s+/g, ''));
  if (!valueCents) return null;

  return { targetMsisdn: target, valueCents, operator: 'Claro' };
}
