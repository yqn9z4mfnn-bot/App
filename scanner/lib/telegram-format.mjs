function esc(text) {
  return String(text ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  } catch {
    return iso;
  }
}

export function formatTelegramReport(summary) {
  const lines = [
    '<b>📱 Claro Recarga — Varredura</b>',
    '',
    `<b>Número:</b> ${esc(summary.numero)}`,
    `<b>Segmento:</b> ${esc(summary.segmento)}`,
    `<b>Status:</b> ${esc(summary.cliente?.status)}`,
    `<b>Perfil:</b> ${esc(summary.cliente?.profile?.name)}`,
  ];

  if (summary.cliente?.profile) {
    const p = summary.cliente.profile;
    lines.push(
      `<b>Limite hoje:</b> R$ ${((p.todays_reload_amount ?? 0) / 100).toFixed(2).replace('.', ',')} / R$ ${((p.remaining_spending_limit ?? 0) / 100).toFixed(2).replace('.', ',')}`,
    );
  }

  lines.push('', `<b>💰 Valores (${summary.valoresDisponiveis.length})</b>`);
  for (const v of summary.valoresDisponiveis) {
    lines.push(`• ${esc(v.name)} (${v.validityDays ?? '?'}d)`);
  }
  if (summary.valoresDisponiveis.length === 0) lines.push('Nenhum');

  lines.push('', `<b>💳 Cartões (${summary.cartoes.total})</b>`);
  if (summary.cartoes.total === 0) {
    lines.push('Nenhum');
  } else {
    for (const c of summary.cartoes.walletEldorado) {
      lines.push(`• ${esc(c.brand)} ${esc(c.bin)}****${esc(c.last)} exp ${esc(c.expiration)}`);
    }
    for (const c of summary.cartoes.claroApi) {
      lines.push(`• ${esc(c.brand)} ****${esc(c.last)}`);
    }
  }

  lines.push('', `<b>📜 Histórico (${summary.historico.total})</b>`);
  if (summary.historico.total === 0) {
    lines.push('Vazio');
  } else {
    for (const h of summary.historico.recargas.slice(0, 6)) {
      const icon = h.status === 'ok' ? '✅' : '❌';
      const card = h.cardLast ? ` *${esc(h.cardLast)}` : '';
      lines.push(`${icon} ${esc(h.valueFormatted)} ${esc(h.paymentType)}${card} ${esc(fmtDate(h.date))}`);
    }
    if (summary.historico.total > 6) {
      lines.push(`… +${summary.historico.total - 6}`);
    }
  }

  if (summary.walletScan?.ok === false) {
    lines.push('', `⚠️ ${esc(summary.walletScan.message)}`);
  }

  lines.push('', `<i>⏱ ${summary.meta?.latencyMs ?? '?'}ms</i>`);

  let text = lines.join('\n');
  if (text.length > 3900) text = `${text.slice(0, 3890)}…`;
  return text;
}

/** Botões inline para remover cartões da wallet. */
export function buildCardKeyboard(walletCards) {
  const rows = [[{ text: '💳 Recarregar', callback_data: 'recarga:start' }]];

  if (!walletCards?.length) return { inline_keyboard: rows };

  for (const c of walletCards) {
    rows.push([
      {
        text: `🗑 ${c.brand} *${c.last}`,
        callback_data: `rm:${c.token}`,
      },
    ]);
  }

  if (walletCards.length > 1) {
    rows.push([{ text: '🗑 Remover TODOS', callback_data: 'rmall:confirm' }]);
  }

  return { inline_keyboard: rows };
}

export function buildConfirmKeyboard(token, action = 'rm') {
  return {
    inline_keyboard: [
      [
        { text: '✅ Sim, remover', callback_data: `${action}ok:${token}` },
        { text: '❌ Cancelar', callback_data: 'cancel' },
      ],
    ],
  };
}

export const WELCOME = `<b>Claro Recarga Scanner</b>

• <b>.txt</b> (um número por linha) → gera JWT, lê valores e <b>salva no banco</b> (1 por vez)
• <b>número avulso</b> → varredura normal, <b>não salva</b>
• /valores ou <code>20</code> → envia o <b>link</b> de um número do banco

/valores · /valor 20 · /lista · /erros · /recarga`;
