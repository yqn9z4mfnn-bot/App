import { createSession } from './claro.mjs';
import { claroGet } from './http.mjs';
import { fetchClaroLoginLink, normalizeBrMobile } from './fetch-claro-link.mjs';
import { parseLink } from './parse-link.mjs';
import { sleep } from './transient-fetch.mjs';

/** Espera a API prepaid refletir a recarga (às vezes demora mais que 2–3s). */
export const AFTER_BALANCE_POLL_MS = [3000, 5000, 7000, 8000];

export function formatBRLCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return '—';
  return `R$ ${(n / 100).toFixed(2).replace('.', ',')}`;
}

export function formatValidityDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  } catch {
    return s;
  }
}

export function parseBalanceBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const cents = Number(body.total ?? body.value ?? body.amount ?? body.balance);
  if (!Number.isFinite(cents)) return null;
  const expiration = body.expiration_date ?? body.expirationDate ?? body.dueDate ?? null;
  return {
    cents,
    expiration: expiration ? String(expiration) : null,
    bonus: Array.isArray(body.bonus) ? body.bonus : [],
  };
}

export function formatBalanceLine(snap) {
  if (!snap || !Number.isFinite(snap.cents)) return 'indisponível';
  const money = formatBRLCents(snap.cents);
  const val = formatValidityDate(snap.expiration);
  return val ? `${money} · val. ${val}` : money;
}

export function balancesChanged(before, after) {
  if (!after || !Number.isFinite(after.cents)) return false;
  if (!before || !Number.isFinite(before.cents)) return true;
  if (before.cents !== after.cents) return true;
  return String(before.expiration ?? '') !== String(after.expiration ?? '');
}

export function formatBalanceCompare(before, after, { stale = false } = {}) {
  const lines = ['📊 Saldo do destino'];
  if (before) lines.push(`Antes: ${formatBalanceLine(before)}`);
  else lines.push('Antes: não consultado');
  if (after) {
    lines.push(`Depois: ${formatBalanceLine(after)}`);
    if (before && Number.isFinite(before.cents) && Number.isFinite(after.cents)) {
      const delta = after.cents - before.cents;
      if (delta !== 0) lines.push(`Δ ${delta > 0 ? '+' : ''}${formatBRLCents(delta)}`);
      else if (stale || !balancesChanged(before, after)) {
        lines.push('⏳ A API ainda não atualizou o saldo (atraso comum)');
      }
    }
    if (before?.expiration && after?.expiration && before.expiration !== after.expiration) {
      lines.push(
        `Validade ${formatValidityDate(before.expiration)} → ${formatValidityDate(after.expiration)}`,
      );
    }
  } else {
    lines.push('Depois: não consultado');
  }
  return lines.join('\n');
}

export async function fetchRechargeBalance(sessionId, msisdn) {
  const number = normalizeBrMobile(msisdn);
  if (!sessionId || !number) {
    return { ok: false, status: 0, body: null };
  }
  return claroGet(`/customers/${number}/recharge/balance`, sessionId, {
    retries: 2,
    timeoutMs: 12_000,
  });
}

export async function openDestSession(msisdn, { loginLink = null } = {}) {
  const number = normalizeBrMobile(msisdn);
  if (!number) throw new Error('Destino inválido');
  const link = loginLink || (await fetchClaroLoginLink(number)).link;
  const session = await createSession(parseLink(link).jwt);
  return {
    sessionId: session.id,
    msisdn: session.identifier || number,
    link,
  };
}

/** Consulta saldo/validade da linha destino (precisa login dela). */
export async function snapshotDestBalance(msisdn, { sessionId = null, loginLink = null } = {}) {
  const number = normalizeBrMobile(msisdn);
  if (!number) return { ok: false, error: 'destino inválido' };

  let sid = sessionId;
  let ident = number;
  try {
    if (!sid) {
      const opened = await openDestSession(number, { loginLink });
      sid = opened.sessionId;
      ident = opened.msisdn;
    }
    let res = await fetchRechargeBalance(sid, ident);
    if (res.status === 401 || res.status === 403) {
      const opened = await openDestSession(number);
      sid = opened.sessionId;
      ident = opened.msisdn;
      res = await fetchRechargeBalance(sid, ident);
    }
    if (res.status === 404) {
      return { ok: false, sessionId: sid, msisdn: ident, error: 'sem saldo prepaid' };
    }
    if (!res.ok) {
      return {
        ok: false,
        sessionId: sid,
        msisdn: ident,
        error: `HTTP ${res.status}`,
      };
    }
    const balance = parseBalanceBody(res.body);
    if (!balance) {
      return { ok: false, sessionId: sid, msisdn: ident, error: 'resposta sem valor' };
    }
    return { ok: true, sessionId: sid, msisdn: ident, balance };
  } catch (err) {
    return { ok: false, sessionId: sid, msisdn: ident, error: err.message || String(err) };
  }
}

/**
 * Relê o saldo depois da aprovada até mudar valor/validade ou esgotar as esperas.
 * Na 2ª tentativa em diante abre login novo — a sessão antiga às vezes devolve cache.
 */
export async function snapshotDestBalanceUntilChange(
  msisdn,
  before,
  { sessionId = null, delaysMs = AFTER_BALANCE_POLL_MS, onAttempt } = {},
) {
  let sid = sessionId || null;
  let lastOk = null;
  let lastErr = null;
  for (let i = 0; i < delaysMs.length; i += 1) {
    const waitMs = Math.max(0, Number(delaysMs[i]) || 0);
    if (typeof onAttempt === 'function') {
      await onAttempt({ attempt: i + 1, total: delaysMs.length, waitMs });
    }
    if (waitMs) await sleep(waitMs);
    const freshLogin = i > 0;
    const snap = await snapshotDestBalance(msisdn, {
      sessionId: freshLogin ? null : sid,
    });
    if (snap.sessionId) sid = snap.sessionId;
    if (!snap.ok) {
      lastErr = snap.error;
      continue;
    }
    lastOk = snap;
    if (balancesChanged(before, snap.balance)) {
      return { ...snap, attempts: i + 1, changed: true };
    }
  }
  if (lastOk) {
    return { ...lastOk, attempts: delaysMs.length, changed: false };
  }
  return {
    ok: false,
    sessionId: sid,
    error: lastErr || 'não consultado',
    attempts: delaysMs.length,
    changed: false,
  };
}
