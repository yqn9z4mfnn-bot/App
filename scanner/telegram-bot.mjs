#!/usr/bin/env node
import { runScan } from './lib/run-scan.mjs';
import {
  deleteWalletCard,
  deleteAllWalletCards,
} from './lib/eldorado.mjs';
import {
  formatTelegramReport,
  buildCardKeyboard,
  buildConfirmKeyboard,
  WELCOME,
} from './lib/telegram-format.mjs';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('Defina TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
let offset = 0;
const busy = new Set();
const cache = new Map(); // chatId -> { link, walletAuth, cards, expiresAt }
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

async function doScan(chatId, link, { skipWallet = false, editMsg = null } = {}) {
  if (busy.has(chatId)) {
    await send(chatId, '⏳ Aguarde a operação anterior…');
    return;
  }

  busy.add(chatId);
  let statusMsg = editMsg;
  if (!statusMsg) {
    statusMsg = await send(chatId, skipWallet ? '🔍 Varredura…' : '⚡ Varredura rápida…');
  }

  try {
    const result = await runScan(link, { skipWallet, full: false });
    const { summary, walletAuth, wallet } = result;
    const report = formatTelegramReport(summary);

    const rawCards = wallet?.walletCards?.body ?? [];
    if (walletAuth && rawCards.length) {
      setCache(chatId, { link, walletAuth, cards: rawCards });
    }

    const keyboard = buildCardKeyboard(rawCards);
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: report,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard,
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

async function handleRemove(chatId, messageId, cardToken, cardLabel) {
  const entry = getCache(chatId);
  if (!entry?.walletAuth) {
    await tg('answerCallbackQuery', {
      callback_query_id: cardToken,
      text: 'Faça uma varredura primeiro (envie o link)',
      show_alert: true,
    }).catch(() => {});
    return;
  }

  await tg('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: buildConfirmKeyboard(cardToken, 'rm'),
  });

  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: `⚠️ <b>Confirmar remoção?</b>\n\nCartão: <b>${cardLabel}</b>\n\nEsta ação não pode ser desfeita.`,
    parse_mode: 'HTML',
    reply_markup: buildConfirmKeyboard(cardToken, 'rm'),
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
      text: `✅ <b>Removido:</b> ${label}\n\nAtualizando varredura…`,
      parse_mode: 'HTML',
    });

    await doScan(chatId, entry.link, { editMsg: { message_id: messageId } });
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
    await send(chatId, '❌ Nenhum cartão em cache. Varredura necessária.');
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
      text: `✅ <b>${ok}/${total}</b> cartões removidos.\n\nAtualizando…`,
      parse_mode: 'HTML',
    });

    await doScan(chatId, entry.link, { editMsg: { message_id: messageId } });
  } catch (err) {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `❌ Falha: ${err.message}`,
      parse_mode: 'HTML',
    });
  }
}

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  await tg('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

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

  if (text === '/start' || text === '/help') {
    await send(chatId, WELCOME);
    return;
  }

  if (text === '/status') {
    await send(chatId, `🟢 Online · ${Math.floor(process.uptime())}s · ⚡ modo rápido`);
    return;
  }

  if (text === '/cartoes') {
    const entry = getCache(chatId);
    if (!entry?.cards?.length) {
      await send(chatId, '❌ Nenhum cartão em cache.\n\nEnvie o link JWT para varrer primeiro.');
      return;
    }
    await send(chatId, `<b>Cartões (${entry.cards.length})</b> — toque para remover:`, {
      reply_markup: buildCardKeyboard(entry.cards),
    });
    return;
  }

  const skipWallet = text.startsWith('/scan');
  const link = extractLink(skipWallet ? text.replace(/^\/scan\s*/, '') : text);

  if (!link) {
    if (text.startsWith('/')) {
      await send(chatId, 'Comando desconhecido. /start');
    } else {
      await send(chatId, '❌ Envie o link <code>?t=...</code> ou JWT puro.');
    }
    return;
  }

  await doScan(chatId, link, { skipWallet });
}

async function poll() {
  console.log('[bot] polling (fast mode + remove cards)…');
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
