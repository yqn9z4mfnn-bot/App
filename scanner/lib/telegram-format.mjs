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
    `<b>Origem:</b> ${esc(summary.cliente?.registerOrigin)}`,
  ];

  if (summary.cliente?.profile) {
    const p = summary.cliente.profile;
    lines.push(
      `<b>Limite hoje:</b> R$ ${((p.todays_reload_amount ?? 0) / 100).toFixed(2).replace('.', ',')} / R$ ${((p.remaining_spending_limit ?? 0) / 100).toFixed(2).replace('.', ',')}`,
    );
  }

  lines.push('', `<b>💰 Valores disponíveis (${summary.valoresDisponiveis.length})</b>`);
  if (summary.valoresDisponiveis.length === 0) {
    lines.push('Nenhum');
  } else {
    for (const v of summary.valoresDisponiveis) {
      lines.push(`• ${esc(v.name)} — ${esc(v.category)} (${v.validityDays ?? '?'} dias)`);
    }
  }

  lines.push('', `<b>💳 Cartões (${summary.cartoes.total})</b>`);
  if (summary.cartoes.total === 0) {
    lines.push('Nenhum cartão vinculado');
  } else {
    for (const c of summary.cartoes.walletEldorado) {
      lines.push(`• 🏦 ${esc(c.brand)} ${esc(c.bin)}****${esc(c.last)} exp ${esc(c.expiration)}`);
    }
    for (const c of summary.cartoes.claroApi) {
      lines.push(`• 📋 ${esc(c.brand)} ****${esc(c.last)}`);
    }
  }
  if (summary.cartoes.nota) {
    lines.push(`<i>${esc(summary.cartoes.nota)}</i>`);
  }

  lines.push('', `<b>📜 Histórico (${summary.historico.total})</b>`);
  if (summary.historico.total === 0) {
    lines.push('Vazio');
  } else {
    for (const h of summary.historico.recargas.slice(0, 8)) {
      const icon = h.status === 'ok' ? '✅' : '❌';
      const card = h.cardLast ? ` ${esc(h.cardBrand)} *${esc(h.cardLast)}` : '';
      lines.push(
        `${icon} ${esc(h.valueFormatted)} — ${esc(h.paymentType)}${card} — ${esc(fmtDate(h.date))}`,
      );
    }
    if (summary.historico.total > 8) {
      lines.push(`… +${summary.historico.total - 8} registros`);
    }
  }

  if (summary.historico.programadas?.length > 0) {
    lines.push('', `<b>🗓 Programadas:</b> ${summary.historico.programadas.length}`);
  }

  if (summary.walletScan?.ok === false) {
    lines.push('', `⚠️ <i>Wallet: ${esc(summary.walletScan.message)}</i>`);
  }

  lines.push(
    '',
    `<i>⏱ ${summary.meta?.latencyMs ?? '?'}ms · ${esc(summary.scannedAt)}</i>`,
  );

  let text = lines.join('\n');
  if (text.length > 4000) {
    text = `${text.slice(0, 3990)}…`;
  }
  return text;
}

export const WELCOME = `<b>Claro Recarga Scanner</b>

Envie o <b>link de login</b> ou o <b>JWT</b> (<code>?t=...</code>) para varrer:

• Número e perfil
• Valores de recarga
• Cartões vinculados (wallet)
• Histórico

<b>Comandos:</b>
/start — ajuda
/scan — modo rápido (sem wallet)
/status — status do bot`;
