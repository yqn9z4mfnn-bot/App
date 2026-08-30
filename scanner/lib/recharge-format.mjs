import { isCheckoutErrorText, looksLikeCheckoutError, looksLikeCheckoutSuccess } from './checkout-error.mjs';

function esc(text) {
  return String(text ?? '')
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

function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function clip(text, max = 48) {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function shortReason(msg) {
  const t = String(msg ?? '');
  if (!t.trim()) return '';
  if (/fraud|fraude|suspeit/i.test(t)) return 'Fraude suspeita';
  if (/insuficiente|saldo/i.test(t)) return 'Saldo insuficiente';
  if (isCheckoutErrorText(t)) {
    const code = t.match(/informe c[oó]digo\s*(\d+)/i) || t.match(/c[oó]digo\s+(\d+)/i);
    if (code && /compra n[aã]o conclu[ií]da|informe c[oó]digo/i.test(t)) {
      return `Compra não concluída (código ${code[1]})`;
    }
    return 'Não foi possível concluir o pagamento';
  }
  if (/3ds|vbv|banco/i.test(t)) return 'Confirme no banco';
  if (/timeout|esgotad/i.test(t)) return 'Tempo esgotado';
  if (/proxy|fetch failed|rede/i.test(t)) return 'Falha de rede';
  const cleaned = t
    .replace(/CREDIT_CARD\s*-\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^422\b/.test(cleaned) && /negad|denied|recus/i.test(cleaned)) {
    return 'Negada pela operadora';
  }
  return clip(cleaned, 56);
}

function inferTitle(status, footer, hint) {
  const s = String(status ?? '');
  const h = String(hint || footer || '');
  if (/quem recebe|destino|recebe/i.test(s + h)) return 'Quem recebe?';
  if (/escolha.*valor|valor/i.test(s + h)) return 'Escolha o valor';
  if (/pagamento|paga/i.test(s + h)) return 'Forma de pagamento';
  if (/cartão|fila|🤖/i.test(s)) return 'Cartão';
  if (/aprov|sucesso|🎉/i.test(s)) return 'Recarga aprovada';
  if (/negad|recus|😔/i.test(s)) return 'Recarga negada';
  if (/3ds|vbv|🔐|📲/i.test(s)) return 'Validação 3DS';
  if (/timeout|esgot|⏰/i.test(s)) return 'Tempo esgotado';
  if (/erro|falha|❌|🔧/i.test(s)) return 'Erro na recarga';
  if (/cancel/i.test(s)) return 'Recarga cancelada';
  if (/retry|tentando|🔄/i.test(s)) return 'Nova tentativa';
  if (/process/i.test(s)) return 'Processando';
  if (/envie o número/i.test(s + h)) return 'Mesmo número';
  if (/envie o cartão/i.test(s + h)) return 'Cartão manual';
  if (/gerando|prepar|login|valores|🎲|🔗|limpando|🧹|abrindo|procurando/i.test(s)) {
    return 'Preparando';
  }
  return clip(s.replace(/^[^\p{L}\p{N}]+/u, '') || 'Recarga', 24);
}

function inferHint(status, footer, hint) {
  if (hint) return hint;
  if (footer && footer !== '—') return footer;
  const s = String(status ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return clip(s, 48);
}

function formatMsisdnLine(login, target) {
  const a = digits(login);
  const b = digits(target);
  if (a && b && a !== b) {
    return `🔑 <code>${esc(a)}</code>  →  📱 <code>${esc(b)}</code>`;
  }
  if (a) return `📱 <code>${esc(a)}</code>`;
  if (b) return `📱 <code>${esc(b)}</code>`;
  return '';
}

function formatGateReason(msg) {
  const t = String(msg ?? '').trim();
  if (!t) return '';
  const short = shortReason(t);
  if (short) return short;
  return clip(t.replace(/CREDIT_CARD\s*-\s*/i, ''), 56);
}

/** Mensagem do fluxo — texto normal, sem blockquote. */
export function formatStatusBubble({
  title = '',
  valueLabel = '',
  cardMask = '',
  login = '',
  target = '',
  status = '',
  footer = '',
  hint = '',
  subhint = '',
} = {}) {
  const head = esc(clip(title || inferTitle(status, footer, hint), 28));
  const val = String(valueLabel ?? '').trim();
  const card = String(cardMask ?? '').trim();
  const note = hint || inferHint(status, footer, hint);
  const extra = subhint || '';

  const lines = [`<b>${head}</b>`, ''];

  if (val && val !== '—') {
    lines.push(`💰 <b>${esc(val)}</b>`);
  }

  const msisdn = formatMsisdnLine(login, target);
  if (msisdn) lines.push(msisdn);

  if (card && card !== '—' && !/^cartão$/i.test(card)) {
    lines.push(`💳 <code>${esc(card)}</code>`);
  }

  if (note) lines.push('', `<i>${esc(note)}</i>`);
  if (extra && extra !== note) lines.push(`<i>${esc(extra)}</i>`);

  return lines.join('\n');
}

export function formatQueueFooter(action, pendingLeft) {
  const n = pendingLeft ?? '—';
  if (action === 'approved') return `Aprovado · fila ${n}`;
  if (action === 'consumed') return `Removido da fila · restam ${n}`;
  if (action === 'return') return `Voltou pra fila · ${n} pendente(s)`;
  return `Fila ${n}`;
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
    automation,
  } = outcome ?? {};

  let status = normalizeStatus(result?.status);
  const visualVbv = Boolean(result?.visualVbv);
  const threeDsKind = result?.threeDsKind ?? null;
  let reason =
    result?.negativeReason ??
    result?.extra?.postMessage?.transaction?.reason ??
    result?.message ??
    automation?.raw?.gateMessage ??
    automation?.raw?.message ??
    '';
  const pageUrl = automation?.raw?.url || automation?.url || result?.pageUrl || '';
  const threeDsHint = result?.threeDsHint || automation?.raw?.threeDs?.hint || '';
  if (looksLikeCheckoutSuccess({ url: pageUrl, message: `${reason} ${threeDsHint}` })) {
    status = 'SUCCESS';
  }
  if (
    status === '3DS_REQUIRED' &&
    looksLikeCheckoutError({ url: pageUrl, message: `${reason} ${threeDsHint}` })
  ) {
    status = 'DENIED';
    reason = isCheckoutErrorText(threeDsHint)
      ? threeDsHint
      : isCheckoutErrorText(reason)
        ? reason
        : 'Não foi possível concluir o pagamento';
  }

  const login = String(loginMsisdn ?? '').replace(/\D/g, '');
  const target = String(targetMsisdn ?? login).replace(/\D/g, '');

  let title = 'Resultado';
  if (status === 'SUCCESS') title = 'Recarga aprovada';
  else if (status === '3DS_REQUIRED') {
    title = visualVbv || threeDsKind === 'cardinal' ? '3DS visual' : threeDsKind === 'sms' ? '3DS por SMS' : 'Validação 3DS';
  } else if (status === 'DENIED') title = 'Recarga negada';
  else if (status === 'AUTOMATION_FAIL') title = 'Falha na automação';
  else if (status === 'TIMEOUT') title = 'Tempo esgotado';
  else if (status === 'ERROR') title = 'Erro na recarga';

  let hint = '';
  if (status === 'SUCCESS') {
    hint = formatSeconds(latencyMs) ? `${formatSeconds(latencyMs)}` : '';
  } else if (status === '3DS_REQUIRED') {
    hint = 'Confirme no app ou SMS do banco';
  } else {
    hint =
      formatGateReason(reason) ||
      (status === 'DENIED'
        ? 'Negada pela operadora'
        : status === 'TIMEOUT'
          ? 'Tempo esgotado'
          : status === 'AUTOMATION_FAIL'
            ? 'Falha na automação'
            : status === 'ERROR'
              ? 'Erro na recarga'
              : reason
                ? clip(String(reason), 56)
                : 'Sem detalhe da gate');
  }

  return formatStatusBubble({
    title,
    valueLabel: formatBRL(valueCents ?? 0),
    cardMask: cardMask || '',
    login,
    target,
    hint,
    subhint: extraFooter || '',
  });
}

/** Quantas vezes o bot aperta “Tentar novamente” sozinho (além da 1ª recarga). */
export const MAX_AUTO_RECHARGE_RETRIES = Math.max(
  0,
  Number(process.env.MAX_AUTO_RECHARGE_RETRIES) || 3,
);

export function isRechargeSuccess(outcome) {
  const st = String(outcome?.result?.status ?? '').toUpperCase();
  if (st === 'CONFIRMED' || st === 'SUCCESS') return true;
  const raw = outcome?.automation?.raw ?? {};
  return looksLikeCheckoutSuccess({
    url: raw.url,
    message: `${outcome?.result?.message ?? ''} ${raw.gateMessage ?? ''} ${raw.threeDs?.hint ?? ''}`,
  });
}

/** 3DS/VBV real — não retry automático nem botão. checkout/error e checkout/success não contam. */
export function isRecharge3ds(outcome) {
  if (!outcome || isRechargeSuccess(outcome)) return false;
  const result = outcome?.result ?? {};
  const raw = outcome?.automation?.raw ?? {};
  const pageUrl = raw.url || outcome?.url || result.pageUrl || '';
  const reason = `${result.negativeReason ?? ''} ${result.message ?? ''} ${raw.gateMessage ?? ''} ${raw.message ?? ''}`;
  const threeDsHint = result.threeDsHint || raw.threeDs?.hint || '';
  const blob = `${reason} ${threeDsHint}`;
  if (looksLikeCheckoutSuccess({ url: pageUrl, message: blob })) return false;
  if (looksLikeCheckoutError({ url: pageUrl, message: blob })) return false;
  const st = String(result.status ?? raw.status ?? '').toUpperCase();
  return st === '3DS_REQUIRED' || st === '3DS';
}

export function shouldOfferRechargeRetry(outcome, error) {
  if (isRechargeSuccess(outcome)) return false;
  if (!error && isRecharge3ds(outcome)) return false;
  return true;
}

export function shouldScheduleAutoRetry({
  outcome,
  error,
  autoRetriesUsed = 0,
  pendingCards = 0,
} = {}) {
  if (!shouldOfferRechargeRetry(outcome, error)) return false;
  if (Number(pendingCards) <= 0) return false;
  return Number(autoRetriesUsed) < MAX_AUTO_RECHARGE_RETRIES;
}

export function buildRetryKeyboard({ autoAvailable = false } = {}) {
  const hint = autoAvailable ? ' · próximo cartão' : '';
  return {
    inline_keyboard: [
      [{ text: `🔄 Tentar novamente${hint}`, callback_data: 'rcg:retry' }],
      [{ text: '🏠 Recomeçar', callback_data: 'rcg:home' }],
    ],
  };
}

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
