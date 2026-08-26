function esc(text) {
  return String(text ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatBRL(cents) {
  return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

export function formatRechargeResult(outcome) {
  const {
    result,
    valueCents,
    cardMask,
    paymentId,
    latencyMs,
    automation,
    mode,
  } = outcome ?? {};

  const status = (result?.status ?? 'UNKNOWN').toUpperCase();
  const reason =
    result?.negativeReason ??
    result?.extra?.postMessage?.transaction?.reason ??
    result?.message ??
    '';

  let icon = '⏳';
  let title = 'Processando';
  if (status === 'SUCCESS' || status === 'OK') {
    icon = '✅';
    title = 'Recarga aprovada';
  } else if (status === 'DENIED' || status === 'FAILURE' || status === 'NOK') {
    icon = '❌';
    title = 'Recarga negada';
  } else if (status === 'TIMEOUT') {
    icon = '⚠️';
    title = 'Timeout';
  } else if (status === 'RATE_LIMIT') {
    icon = '⏳';
    title = 'Muitas tentativas';
  } else if (status === 'CHECKOUT_ERROR') {
    icon = '⚠️';
    title = 'Checkout indisponível';
  }

  const lines = [
    `<b>${icon} ${title}</b>`,
    '',
    `<b>Valor:</b> ${formatBRL(valueCents ?? 0)}`,
    `<b>Cartão:</b> ${esc(cardMask)}`,
    `<b>Status:</b> ${esc(status)}`,
  ];

  if (reason) lines.push(`<b>Motivo:</b> ${esc(reason)}`);
  const idLabel = mode === 'browser' ? 'NSU/ID' : 'ID';
  if (paymentId) lines.push(`<b>${idLabel}:</b> <code>${esc(paymentId)}</code>`);
  if (latencyMs) lines.push('', `<i>⏱ ${latencyMs}ms</i>`);

  if (mode === 'browser' && automation?.stepLabel) {
    lines.push('', `<i>🌐 ${esc(automation.stepLabel)}</i>`);
  }

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

export const RECHARGE_HELP = `<b>💳 Recarga</b>

1. Link JWT → varredura
2. /recarga → escolha valor
3. Envie o cartão:

<code>NUMERO|MM|AAAA|CVV</code>

Ex: <code>4271680002723941|08|2033|999</code>
<i>Nome aleatório automático.</i>`;
