import './load-env.mjs';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

export async function notifyTelegramChat(chatId, text, { parseMode = 'HTML', replyMarkup = undefined } = {}) {
  if (!TOKEN || chatId == null) return { ok: false, error: 'no_token_or_chat' };
  const body = {
    chat_id: chatId,
    text: String(text),
    parse_mode: parseMode,
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) return { ok: false, error: data.description || 'telegram_error' };
    return { ok: true, messageId: data.result?.message_id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
