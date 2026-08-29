import { insertRechargeEvent } from './admin-db.mjs';

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
    const pan = String(card?.number ?? card?.pan ?? '').replace(/\D/g, '');
    const last4 = pan.length >= 4 ? pan.slice(-4) : null;
    const status = error
      ? 'error'
      : outcome?.status === 'success' || outcome?.status === 'done'
        ? 'success'
        : outcome?.status === '3ds_required'
          ? '3ds_required'
          : outcome?.status ?? 'unknown';

    insertRechargeEvent({
      chatId: chatId != null ? String(chatId) : null,
      username,
      loginMsisdn,
      targetMsisdn,
      productName,
      productValueCents,
      cardLast4: last4,
      status,
      gateCode: outcome?.gateCode ?? outcome?.gate_code ?? null,
      gateMessage: outcome?.gateMessage ?? outcome?.message ?? error?.message ?? null,
      mode,
      durationMs: startedAt ? Date.now() - startedAt : null,
      rawJson: { outcome: outcome ?? null, error: error?.message ?? null },
    });
  } catch (err) {
    console.warn('[recharge-events]', err.message);
  }
}
