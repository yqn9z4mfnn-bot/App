import { insertRechargeEvent, backfillRechargeEvent } from './admin-db.mjs';

const SUCCESS = new Set(['CONFIRMED', 'SUCCESS', 'DONE', 'OK']);
const DENIED = new Set(['DENIED', 'REJECTED', 'FAILURE', 'NOK', 'DENIED']);
const THREEDS = new Set(['3DS_REQUIRED', '3DS']);
const FAIL = new Set(['AUTOMATION_FAIL', 'ERROR_MANUAL']);

export function normalizeRechargeStatus(outcome, error) {
  if (error) return 'error';
  const candidates = [
    outcome?.status,
    outcome?.result?.status,
    outcome?.paymentResult?.status,
    outcome?.automation?.raw?.status,
    outcome?.gateCode,
    outcome?.result?.gateCode,
    outcome?.automation?.raw?.gateCode,
    outcome?.automation?.raw?.gateResponse?.body?.status,
  ];
  for (const c of candidates) {
    const s = String(c ?? '').toUpperCase();
    if (!s) continue;
    if (SUCCESS.has(s)) return 'success';
    if (THREEDS.has(s)) return '3ds';
    if (DENIED.has(s)) return 'denied';
    if (s === 'TIMEOUT') return 'timeout';
    if (FAIL.has(s)) return 'fail';
    if (s === 'ERROR') return 'error';
  }
  return 'unknown';
}

export function extractGate(outcome, error) {
  const gateCode =
    outcome?.result?.gateCode ??
    outcome?.gateCode ??
    outcome?.automation?.raw?.gateCode ??
    outcome?.automation?.raw?.gateResponse?.body?.status ??
    null;
  const gateMessage =
    outcome?.result?.message ??
    outcome?.result?.negativeReason ??
    outcome?.gateMessage ??
    outcome?.message ??
    outcome?.automation?.raw?.gateMessage ??
    error?.message ??
    null;
  return {
    gateCode: gateCode != null ? String(gateCode) : null,
    gateMessage: gateMessage != null ? String(gateMessage) : null,
  };
}

export function extractCardLast4(card, outcome) {
  const pan = String(card?.number ?? card?.pan ?? '').replace(/\D/g, '');
  if (pan.length >= 4) return pan.slice(-4);
  const mask = String(outcome?.cardMask ?? '');
  const m = mask.match(/(\d{4})\s*$/);
  return m ? m[1] : null;
}

export function enrichRechargeFromRaw(row) {
  if (!row) return row;
  let parsed = null;
  if (row.raw_json) {
    try {
      parsed = JSON.parse(row.raw_json);
    } catch {
      parsed = null;
    }
  }
  const outcome = parsed?.outcome ?? null;
  const error = parsed?.error ? { message: parsed.error } : null;
  const needsStatus = !row.status || row.status === 'unknown';
  const status = needsStatus ? normalizeRechargeStatus(outcome, error) : row.status;
  const gate = extractGate(outcome, error);
  return {
    ...row,
    status,
    gate_code: row.gate_code || gate.gateCode,
    gate_message: row.gate_message || gate.gateMessage,
    card_last4: row.card_last4 || extractCardLast4(null, outcome),
  };
}

export function logRechargeEvent({
  chatId,
  username,
  loginMsisdn,
  targetMsisdn,
  productName,
  productValueCents,
  card,
  outcome,
  error,
  mode,
  startedAt,
}) {
  try {
    const { gateCode, gateMessage } = extractGate(outcome, error);
    insertRechargeEvent({
      chatId: chatId != null ? String(chatId) : null,
      username,
      loginMsisdn,
      targetMsisdn,
      productName,
      productValueCents,
      cardLast4: extractCardLast4(card, outcome),
      status: normalizeRechargeStatus(outcome, error),
      gateCode,
      gateMessage,
      mode,
      durationMs: startedAt ? Date.now() - startedAt : null,
      rawJson: { outcome: outcome ?? null, error: error?.message ?? null },
    });
  } catch (err) {
    console.warn('[recharge-events]', err.message);
  }
}

export function repairRechargeRow(row) {
  const enriched = enrichRechargeFromRaw(row);
  if (
    enriched &&
    (enriched.status !== row.status ||
      enriched.gate_code !== row.gate_code ||
      enriched.gate_message !== row.gate_message)
  ) {
    backfillRechargeEvent(row.id, {
      status: enriched.status,
      gateCode: enriched.gate_code,
      gateMessage: enriched.gate_message,
      cardLast4: enriched.card_last4,
    });
  }
  return enriched;
}
