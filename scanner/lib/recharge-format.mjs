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

export const BUBBLE_LINES = 8;
const FIELD_MAX = 28;

function digits(value) {
  return String(value ?? '').replace(/\D/g, '') || '—';
}

function clip(text, max = FIELD_MAX) {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '—';
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function shortReason(msg) {
  const t = String(msg ?? '');
  if (!t.trim()) return '—';
  if (/fraud|fraude|suspeit/i.test(t)) return 'fraude suspeita';
  if (/insuficiente|saldo/i.test(t)) return 'saldo insuficiente';
  if (/3ds|vbv|banco/i.test(t)) return 'confirme no banco';
  if (/timeout|esgotad/i.test(t)) return 'tempo esgotado';
  if (/proxy|fetch failed|rede/i.test(t)) return 'falha de rede';
  if (/negad|denied|recus/i.test(t)) return 'negada pela gate';
  return clip(t.replace(/CREDIT_CARD\s*-\s*/i, ''), FIELD_MAX);
}

/** Bolha fixa (sempre 8 linhas) — não cresce quando o bot edita. */
export function formatStatusBubble({
  title = 'Recarga',
  valueLabel = '—',
  cardMask = '—',
  login = '—',
  target = '—',
  status = '…',
  footer = '—',
} = {}) {
  const loginD = digits(login);
  const targetD = digits(target);
  return [
    `<b>${esc(clip(title, 22))}</b>`,
    `💰 ${esc(clip(valueLabel, 20))}`,
    `💳 ${esc(clip(cardMask, 16))}`,
    `🔑 <code>${esc(loginD)}</code>`,
    `📱 <code>${esc(targetD)}</code>`,
    '',
    esc(clip(status, FIELD_MAX)),
    `<i>${esc(clip(footer, FIELD_MAX))}</i>`,
  ].join('\n');
}

export function formatQueueFooter(action, pendingLeft) {
  const n = pendingLeft ?? '—';
  if (action === 'approved') return `✅ aprovado · fila ${n}`;
  if (action === 'consumed') return `🚫 saiu · fila ${n}`;
  if (action === 'return') return `↩️ voltou · fila ${n}`;
  return `fila ${n}`;
}

function normalizeStatus(raw) {
  const st = String(raw ?? 'UNKNOWN').toUpperCase();
  if (st === 'CONFIRMED') return 'SUCCESS';
  if (st === 'REJECTED' || st === 'FAILURE' || st === 'NOK' || st === 'DENIED') return 'DENIED';
  if (st === '3DS_REQUIRED' || st === '3DS') return '3DS_REQUIRED';
  return st;
}


export function formatRechargeResult(outcome, { footer: extraFooter } = {}) {
  const {
    result,
    valueCents,
    cardMask,
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

  let icon = '⏳';
  let title = 'Processando…';
  if (status === 'SUCCESS') {
    icon = '🎉';
    title = 'Aprovada';
  } else if (status === '3DS_REQUIRED') {
    icon = '🔐';
    title = visualVbv || threeDsKind === 'cardinal' ? '3DS visual' : threeDsKind === 'sms' ? '3DS SMS' : '3DS';
  } else if (status === 'DENIED') {
    icon = '😔';
    title = 'Negada';
  } else if (status === 'AUTOMATION_FAIL') {
    icon = '🔧';
    title = 'Falha automação';
  } else if (status === 'TIMEOUT') {
    icon = '⏰';
    title = 'Tempo esgotado';
  } else if (status === 'ERROR') {
    icon = '❌';
    title = 'Erro';
  }

  let footer = extraFooter ?? '—';
  if (!extraFooter) {
    if (status === 'SUCCESS') footer = formatSeconds(latencyMs) ? `⏱ ${formatSeconds(latencyMs)}` : 'ok';
    else if (status === '3DS_REQUIRED') footer = 'confirme no banco';
    else footer = shortReason(reason);
  }

  return formatStatusBubble({
    title: 'Recarga',
    valueLabel: formatBRL(valueCents ?? 0),
    cardMask: cardMask || '—',
    login: login || '—',
    target: target || login || '—',
    status: `${icon} ${title}`,
    footer,
  });
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
