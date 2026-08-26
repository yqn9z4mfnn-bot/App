#!/usr/bin/env node
import { runScan } from './lib/run-scan.mjs';
import { formatTelegramReport, WELCOME } from './lib/telegram-format.mjs';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('Defina TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
let offset = 0;
const busy = new Set();

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

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? '';

  if (text === '/start' || text === '/help') {
    await send(chatId, WELCOME);
    return;
  }

  if (text === '/status') {
    await send(
      chatId,
      `🟢 Bot online\n⏱ Uptime: ${Math.floor(process.uptime())}s\n📡 Polling ativo`,
    );
    return;
  }

  const skipWallet = text.startsWith('/scan');
  const link = extractLink(skipWallet ? text.replace(/^\/scan\s*/, '') : text);

  if (!link) {
    if (text.startsWith('/')) {
      await send(chatId, 'Comando desconhecido. Use /start');
    } else {
      await send(
        chatId,
        '❌ Envie o link <code>select-login?t=...</code> ou o JWT puro.\n\nUse /scan &lt;link&gt; para varredura rápida (sem wallet).',
      );
    }
    return;
  }

  if (busy.has(chatId)) {
    await send(chatId, '⏳ Já existe uma varredura em andamento…');
    return;
  }

  busy.add(chatId);
  const statusMsg = await send(
    chatId,
    skipWallet ? '🔍 Varredura rápida (API Claro)…' : '🔍 Varredura completa…\n<i>~3–5 segundos</i>',
  );

  try {
    const { summary } = await runScan(link, { skipWallet });
    const report = formatTelegramReport(summary);
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: report,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
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

async function poll() {
  console.log('[bot] polling…');
  while (true) {
    try {
      const updates = await tg('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message'],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          handleMessage(update.message).catch((err) => {
            console.error('[bot] handle error:', err.message);
          });
        }
      }
    } catch (err) {
      console.error('[bot] poll error:', err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function main() {
  const me = await tg('getMe');
  console.log(`[bot] @${me.username} (${me.first_name}) online`);
  await tg('deleteWebhook', { drop_pending_updates: false });
  poll();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
