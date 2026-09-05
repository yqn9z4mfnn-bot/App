import { fetchRecharges } from './claro.mjs';
import { openDestSession } from './line-balance.mjs';
import { normalizeBrMobile } from './fetch-claro-link.mjs';
import { sleep } from './transient-fetch.mjs';

export const CLARO_NOK_MESSAGE = 'Claro: recarga não efetivada (nok)';

export function listRechargeItems(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.recharges)) return body.recharges;
  if (Array.isArray(body?.items)) return body.items;
  return [];
}

export function cardLast4FromRecharge(item) {
  return String(item?.paymentMethod?.source?.params?.last ?? '').replace(/\D/g, '').slice(-4);
}

/** Achado mais recente no histórico do login que bate com destino/last4. */
export function findMatchingReload(items, { targetMsisdn, last4, sinceMs = 0 } = {}) {
  const dest = normalizeBrMobile(targetMsisdn);
  const wantLast = String(last4 ?? '').replace(/\D/g, '').slice(-4);
  const rows = listRechargeItems(items)
    .filter((item) => {
      const tgt = normalizeBrMobile(item?.targetMsisdn);
      if (dest && tgt && tgt !== dest) return false;
      if (wantLast && cardLast4FromRecharge(item) && cardLast4FromRecharge(item) !== wantLast) {
        return false;
      }
      if (sinceMs) {
        const t = Date.parse(item?.registerDate || item?.createdAt || item?.date || '');
        if (Number.isFinite(t) && t < sinceMs - 15_000) return false;
      }
      return true;
    })
    .sort((a, b) => Date.parse(b.registerDate || 0) - Date.parse(a.registerDate || 0));
  return rows[0] || null;
}

export function isClaroReloadOk(item) {
  return String(item?.status ?? '').toLowerCase() === 'ok';
}

export function isClaroReloadNok(item) {
  const st = String(item?.status ?? '').toLowerCase();
  return st === 'nok' || st === 'denied' || st === 'error' || st === 'failed';
}

/**
 * Eldorado às vezes devolve CONFIRMED e a Claro grava status nok.
 * Relê o histórico do login até achar o registro.
 */
export async function confirmClaroReload({
  sessionId = null,
  loginMsisdn,
  targetMsisdn,
  last4 = '',
  startedAt = Date.now(),
  delaysMs = [0, 2000, 3500],
} = {}) {
  const login = normalizeBrMobile(loginMsisdn);
  if (!login) return { checked: false, status: 'unknown', error: 'login inválido' };

  let sid = sessionId;
  let lastErr = null;
  for (let i = 0; i < delaysMs.length; i += 1) {
    if (delaysMs[i]) await sleep(delaysMs[i]);
    try {
      if (!sid) {
        const opened = await openDestSession(login);
        sid = opened.sessionId;
      }
      let res = await fetchRecharges(sid, login);
      if (res.status === 401 || res.status === 403) {
        const opened = await openDestSession(login);
        sid = opened.sessionId;
        res = await fetchRecharges(sid, login);
      }
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        sid = null;
        continue;
      }
      const hit = findMatchingReload(res.body, {
        targetMsisdn,
        last4,
        sinceMs: startedAt,
      });
      if (!hit) {
        lastErr = 'ainda não no histórico';
        continue;
      }
      if (isClaroReloadNok(hit)) {
        return { checked: true, ok: false, status: 'nok', item: hit, sessionId: sid };
      }
      if (isClaroReloadOk(hit)) {
        return { checked: true, ok: true, status: 'ok', item: hit, sessionId: sid };
      }
      return { checked: true, ok: null, status: String(hit.status || 'unknown'), item: hit, sessionId: sid };
    } catch (err) {
      lastErr = err.message || String(err);
      sid = null;
    }
  }
  return { checked: false, status: 'unknown', error: lastErr };
}

/** Se a Claro marcou nok, o outcome de CONFIRMED vira negada. */
export function applyClaroNokToOutcome(outcome, confirm) {
  if (!outcome || confirm?.status !== 'nok') return outcome;
  const message = CLARO_NOK_MESSAGE;
  const result = {
    ...(outcome.result || {}),
    status: 'DENIED',
    message,
    negativeReason: message,
    gateCode: 'CLARO_NOK',
  };
  const raw = {
    ...(outcome.automation?.raw || {}),
    status: 'error',
    gateCode: 'CLARO_NOK',
    gateMessage: message,
    message,
    pagamentoErro: true,
  };
  return {
    ...outcome,
    result,
    automation: outcome.automation ? { ...outcome.automation, raw } : { raw },
    claroConfirm: confirm,
  };
}
