function esc(text) {
  return String(text ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatBRL(cents) {
  return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

function normalizeStatus(raw) {
  const st = String(raw ?? 'UNKNOWN').toUpperCase();
  if (st === 'CONFIRMED') return 'SUCCESS';
  if (st === 'REJECTED' || st === 'FAILURE' || st === 'NOK' || st === 'DENIED') return 'DENIED';
  if (st === '3DS_REQUIRED' || st === '3DS') return '3DS_REQUIRED';
  return st;
}

export function formatRechargeResult(outcome) {
  const { result, valueCents, cardMask, paymentId, latencyMs } = outcome ?? {};

  const status = normalizeStatus(result?.status);
  const reason =
    result?.negativeReason ??
    result?.extra?.postMessage?.transaction?.reason ??
    result?.message ??
    '';

  let icon = '⏳';
  let title = 'Processando';
  if (status === 'SUCCESS') {
    icon = '✅';
    title = 'Recarga aprovada';
  } else if (status === '3DS_REQUIRED') {
    icon = '🔐';
    title = '3DS — confirme no Edge';
  } else if (status === 'DENIED') {
    icon = '❌';
    title = 'Recarga negada';
  } else if (status === 'TIMEOUT') {
    icon = '⚠️';
    title = 'Timeout';
  }

  const lines = [
    `<b>${icon} ${title}</b>`,
    '',
    `<b>Valor:</b> ${formatBRL(valueCents ?? 0)}`,
    `<b>Cartão:</b> ${esc(cardMask)}`,
    `<b>Status:</b> ${esc(status)}`,
  ];

  if (reason) lines.push(`<b>Motivo:</b> ${esc(reason)}`);
  if (paymentId) lines.push(`<b>ID:</b> <code>${esc(paymentId)}</code>`);
  if (latencyMs) lines.push('', `<i>⏱ ${latencyMs}ms</i>`);

  return lines.join('\n');
}

/** Teclado com valores disponíveis (máx 8 por página). */
export function buildValueKeyboard(valores) {
  if (!valores?.length) return undefined;

  const rows = [];
  for (let i = 0; i < valores.length; i += 2) {
    const row = valores.slice(i, i + 2).map((v) => ({
      text: v.name ?? formatBRL(v.value),
      callback_data: `rcg:${v.id}`,
    }));
    rows.push(row);
  }
  rows.push([{ text: '❌ Cancelar', callback_data: 'rcg:cancel' }]);
  return { inline_keyboard: rows };
}

/** Escolher cartão salvo ou novo. */
export function buildPayMethodKeyboard(cards) {
  const rows = [[{ text: '💳 Cartão novo', callback_data: 'rcgpay:new' }]];
  for (const c of (cards ?? []).slice(0, 5)) {
    rows.push([
      {
        text: `🏦 ${c.brand} *${c.last}`,
        callback_data: `rcgpay:${c.token}`,
      },
    ]);
  }
  rows.push([{ text: '❌ Cancelar', callback_data: 'rcg:cancel' }]);
  return { inline_keyboard: rows };
}
