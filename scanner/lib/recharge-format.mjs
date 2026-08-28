function esc(text) {
  return String(text ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatBRL(cents) {
  return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

function formatSeconds(ms) {
  if (!ms) return null;
  const s = ms / 1000;
  return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1).replace('.', ',')}s`;
}

function normalizeStatus(raw) {
  const st = String(raw ?? 'UNKNOWN').toUpperCase();
  if (st === 'CONFIRMED') return 'SUCCESS';
  if (st === 'REJECTED' || st === 'FAILURE' || st === 'NOK' || st === 'DENIED') return 'DENIED';
  if (st === '3DS_REQUIRED' || st === '3DS') return '3DS_REQUIRED';
  return st;
}


export function formatRechargeResult(outcome) {
  const {
    result,
    valueCents,
    cardMask,
    paymentId,
    latencyMs,
    loginMsisdn,
    targetMsisdn,
  } = outcome ?? {};

  const status = normalizeStatus(result?.status);
  const visualVbv = Boolean(result?.visualVbv);
  const threeDsKind = result?.threeDsKind ?? null;
  const reason =
    result?.negativeReason ??
    result?.extra?.postMessage?.transaction?.reason ??
    result?.message ??
    '';

  const login = String(loginMsisdn ?? '').replace(/\D/g, '');
  const target = String(targetMsisdn ?? login).replace(/\D/g, '');
  const cross = login && target && login !== target;

  let icon = '⏳';
  let title = 'Processando…';
  if (status === 'SUCCESS') {
    icon = '🎉';
    title = 'Recarga aprovada!';
  } else if (status === '3DS_REQUIRED') {
    if (visualVbv || threeDsKind === 'cardinal') {
      icon = '🔐';
      title = 'VBV visual — aprove no banco';
    } else if (threeDsKind === 'sms') {
      icon = '📲';
      title = '3DS por SMS — aprove no banco';
    } else {
      icon = '🔐';
      title = '3DS — aguardando banco';
    }
  } else if (status === 'DENIED') {
    icon = '😔';
    title = 'Recarga negada';
  } else if (status === 'AUTOMATION_FAIL') {
    icon = '🔧';
    title = 'Falha na automação';
  } else if (status === 'TIMEOUT') {
    icon = '⏰';
    title = 'Tempo esgotado';
  }

  const lines = [
    `<b>${icon} ${title}</b>`,
    '',
    `💰 <b>Valor:</b> ${formatBRL(valueCents ?? 0)}`,
    `💳 <b>Cartão:</b> ${esc(cardMask)}`,
  ];

  if (cross) {
    lines.push(
      `🔑 <b>Login:</b> <code>${esc(login)}</code>`,
      `📱 <b>Destino:</b> <code>${esc(target)}</code>`,
    );
  } else if (target) {
    lines.push(`📱 <b>Número:</b> <code>${esc(target)}</code>`);
  }

  if (status === '3DS_REQUIRED' && (visualVbv || threeDsKind === 'cardinal' || threeDsKind === 'sms')) {
    lines.push(
      '',
      '💡 <i>O Edge foi fechado. Confirme no app do banco, SMS ou token — a recarga conclui sozinha após aprovar.</i>',
    );
  }

  if (reason && status !== 'SUCCESS') {
    lines.push('', `📋 <b>Motivo:</b> ${esc(reason)}`);
  }
  if (result?.threeDsHint) {
    lines.push(`🖥 <b>Tela:</b> ${esc(String(result.threeDsHint).slice(0, 160))}`);
  }
  if (paymentId) lines.push('', `🔗 <b>Ref:</b> <code>${esc(paymentId)}</code>`);

  const timing = formatSeconds(latencyMs);
  if (timing) lines.push('', `<i>⏱ ${timing}</i>`);

  return lines.join('\n');
}

export function isRechargeSuccess(outcome) {
  const st = String(outcome?.result?.status ?? '').toUpperCase();
  return st === 'CONFIRMED' || st === 'SUCCESS';
}

export function shouldOfferRechargeRetry(outcome, error) {
  if (error) return true;
  return !isRechargeSuccess(outcome);
}

/** Botão após recarga não confirmada. */
export function buildRetryKeyboard({ autoAvailable = false } = {}) {
  const hint = autoAvailable ? ' · próximo cartão' : '';
  return {
    inline_keyboard: [
      [{ text: `🔄 Tentar novamente${hint}`, callback_data: 'rcg:retry' }],
      [{ text: '🏠 Recomeçar', callback_data: 'rcg:home' }],
    ],
  };
}

/** Teclado com valores disponíveis (máx 8 por página). */
export function buildValueKeyboard(valores) {
  if (!valores?.length) return undefined;

  const rows = [];
  for (let i = 0; i < valores.length; i += 2) {
    const row = valores.slice(i, i + 2).map((v) => ({
      text: `💰 ${v.name ?? formatBRL(v.value)}`,
      callback_data: `rcg:${v.id}`,
    }));
    rows.push(row);
  }
  rows.push([{ text: '↩️ Cancelar', callback_data: 'rcg:cancel' }]);
  return { inline_keyboard: rows };
}

/** Escolher cartão salvo, automático (lista TXT) ou novo. */
export function buildPayMethodKeyboard(cards, { pendingCards = 0, queueLabel = null } = {}) {
  const rows = [];
  const label = queueLabel ?? String(pendingCards);
  if (pendingCards > 0) {
    rows.push([{ text: `🤖 Automático (${label})`, callback_data: 'rcgpay:auto' }]);
  } else {
    rows.push([{ text: '🤖 Automático (lista vazia)', callback_data: 'rcgpay:auto_empty' }]);
  }
  rows.push([{ text: '✨ Cartão manual', callback_data: 'rcgpay:new' }]);
  for (const c of (cards ?? []).slice(0, 5)) {
    rows.push([
      {
        text: `💳 ${c.brand} ••${c.last}`,
        callback_data: `rcgpay:${c.token}`,
      },
    ]);
  }
  rows.push([{ text: '↩️ Cancelar', callback_data: 'rcg:cancel' }]);
  return { inline_keyboard: rows };
}
