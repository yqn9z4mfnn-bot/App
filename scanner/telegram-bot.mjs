#!/usr/bin/env node
import './lib/load-env.mjs';
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
} from './lib/telegram-format.mjs';
import {
  formatRechargeResult,
  formatStatusBubble,
  formatQueueFooter,
  buildCardListArchiveMeta,
  buildValueKeyboard,
  buildPayMethodKeyboard,
  shouldOfferRechargeRetry,
  shouldScheduleAutoRetry,
  summarizeRechargeAttempt,
  formatAttemptLog,
  isRechargeSuccess,
  MAX_AUTO_RECHARGE_RETRIES,
  buildRetryKeyboard,
} from './lib/recharge-format.mjs';
import {
  snapshotDestBalance,
  snapshotDestBalanceUntilChange,
  formatBalanceCompare,
} from './lib/line-balance.mjs';
import { parseCardInput, CARD_INPUT_HINT, randomHolderName, formatCardMask } from './lib/card-parse.mjs';
import {
  createCardListStore,
  looksLikeCardsTxt,
  extractCardLinesFromText,
  MAX_CARD_LINES_PER_INGEST,
} from './lib/card-list.mjs';
import { classifyCardListAction } from './lib/card-outcome.mjs';
import { confirmClaroReload, applyClaroNokToOutcome } from './lib/claro-reload-confirm.mjs';
import { fetchClaroLoginLink, looksLikeMsisdn, normalizeBrMobile } from './lib/fetch-claro-link.mjs';
import { parseLink } from './lib/parse-link.mjs';
import { describeProxy, resetProxyAgent } from './lib/proxy.mjs';
import { formatFetchError, isTransientFetchError, sleep } from './lib/transient-fetch.mjs';
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
import { upsertTelegramUser, isTelegramUserAllowed } from './lib/admin-db.mjs';
import { logRechargeEvent } from './lib/recharge-events.mjs';
import { getDataDir } from './lib/data-dir.mjs';
import { parseQuickCrossRecharge } from './lib/quick-cross-recharge.mjs';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DATA_DIR = getDataDir();
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
/** Invalida trabalho longo (gerar login) quando o usuário manda outro comando. */
const workEpoch = new Map();
const cache = new Map();
const rechargeFlow = new Map();
/** @type {Map<number, 'same'|'other'>} */
const chatRechargeMode = new Map();
/** @type {Map<number, object>} última recarga falha — para botão "Tentar novamente" */
const rechargeRetry = new Map();
/** Saldo/validade do destino — sobrevive ao retry da mesma recarga. */
const destBalanceByChat = new Map();

function clearDestBalance(chatId) {
  destBalanceByChat.delete(chatId);
}

function bumpWork(chatId) {
  const n = (workEpoch.get(chatId) || 0) + 1;
  workEpoch.set(chatId, n);
  return n;
}

function isWorkStale(chatId, epoch) {
  return workEpoch.get(chatId) !== epoch;
}

/** /start, atalho de recarga e /recarga cancelam o "Aguarde…" de um /start preso. */
function preemptChatWork(chatId) {
  const epoch = bumpWork(chatId);
  busy.delete(chatId);
  return epoch;
}

function isPriorityRechargeText(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (/^\/(start|help|recarga|status|cancelar|cancel)(@|\s|$)/i.test(t)) return true;
  if (parseQuickCrossRecharge(t)) return true;
  return false;
}
const CACHE_TTL = 10 * 60 * 1000;
const BULK_CONCURRENCY = Math.max(1, Number(process.env.BULK_CONCURRENCY || 1));

function cardMaskFrom(card) {
  return formatCardMask(card);
}

async function editBubble(chatId, statusMsg, fields, extra = {}) {
  const text = formatStatusBubble(fields);
  if (!statusMsg?.message_id) {
    return send(chatId, text, extra);
  }
  try {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text,
      parse_mode: 'HTML',
      ...extra,
    });
    return statusMsg;
  } catch (err) {
    if (/message is not modified/i.test(String(err?.message))) return statusMsg;
    console.warn('[bot] editBubble falhou, enviando nova:', err.message);
    return send(chatId, text, extra);
  }
}

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

async function tg(method, body = {}, opts = {}) {
  const maxAttempts = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.description || `Telegram ${method} failed`);
      }
      return data.result;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && isTransientFetchError(err)) {
        await sleep(400 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
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

function saveRetryContext(chatId, {
  mode,
  productId,
  productValue,
  productName,
  targetMsisdn,
  loginMsisdn,
  useAuto = true,
  autoRetries,
  attemptLog,
}) {
  const prev = rechargeRetry.get(chatId);
  rechargeRetry.set(chatId, {
    mode: mode ?? 'same',
    productId,
    productValue,
    productName,
    targetMsisdn: normalizeBrMobile(targetMsisdn),
    loginMsisdn: normalizeBrMobile(loginMsisdn),
    useAuto,
    autoRetries: autoRetries ?? prev?.autoRetries ?? 0,
    attemptLog: attemptLog ?? prev?.attemptLog ?? [],
    savedAt: Date.now(),
  });
}

function appendAttemptLog(chatId, attempt) {
  const prev = rechargeRetry.get(chatId);
  const attemptLog = [...(prev?.attemptLog ?? []), attempt].slice(-MAX_AUTO_RECHARGE_RETRIES);
  if (prev) {
    rechargeRetry.set(chatId, { ...prev, attemptLog });
  } else {
    rechargeRetry.set(chatId, { attemptLog, autoRetries: 0, savedAt: Date.now() });
  }
  return attemptLog;
}

function resetRetryRound(chatId) {
  const prev = rechargeRetry.get(chatId);
  if (!prev) return;
  rechargeRetry.set(chatId, { ...prev, autoRetries: 0, attemptLog: [], savedAt: Date.now() });
}

function planRechargeRetry(chatId, { flow, entry, targetMsisdn, listLine, outcome, error }) {
  if (!shouldOfferRechargeRetry(outcome, error)) {
    clearRetryContext(chatId);
    return { showRetryButton: false, autoRetry: false };
  }

  const attemptsInRound = (rechargeRetry.get(chatId)?.autoRetries ?? 0) + 1;
  saveRetryContext(chatId, {
    mode: flow.mode,
    productId: flow.productId,
    productValue: flow.productValue,
    productName: flow.productName,
    targetMsisdn,
    loginMsisdn: entry.msisdn,
    useAuto: Boolean(flow.autoPay || listLine),
    autoRetries: attemptsInRound,
  });

  const autoRetry = shouldScheduleAutoRetry({
    outcome,
    error,
    autoRetriesUsed: attemptsInRound,
    pendingCards: cardList.countPending(),
  });
  return { showRetryButton: !autoRetry, autoRetry };
}

function clearRetryContext(chatId) {
  rechargeRetry.delete(chatId);
}

async function promptRechargeMode(chatId) {
  clearRecharge(chatId);
  clearRetryContext(chatId);
  clearDestBalance(chatId);
  chatRechargeMode.delete(chatId);
  await send(chatId, WELCOME, { reply_markup: buildRechargeModeKeyboard() });
}

async function purgeLoginCards(chatId, statusMsg, bubble, { sessionId, msisdn, productId }) {
  if (!sessionId || !msisdn || !productId) return { removed: 0, walletAuth: null };
  await editBubble(chatId, statusMsg, {
    ...bubble,
    login: msisdn,
    hint: 'Limpando cartões do login…',
  }).catch(() => {});
  try {
    const purge = await purgeAllLoginCardsStrict({
      sessionId,
      msisdn,
      productId,
      timeoutMs: 8_000,
    });
    if (purge.removed) {
      console.log(`[bot][purge] ${msisdn}: ${purge.removed} removido(s)`);
    }
    return purge;
  } catch (err) {
    console.error('[bot][purge-login]', err.message);
    await editBubble(chatId, statusMsg, {
      ...bubble,
      login: msisdn,
      hint: 'Limpeza pulada — API lenta. Seguindo…',
    }).catch(() => {});
    return { removed: 0, walletAuth: null, skipped: true };
  }
}

/** Prepara sessão Claro + teclado de valores para recarga. */
async function prepareRechargeSession(chatId, accessMsisdn, {
  targetMsisdn = null,
  statusMsg = null,
  title = null,
  mode = null,
  loginLink = null,
  skipValuePrompt = false,
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
  const bubbleFields = {
    title: 'Preparando',
    valueLabel: '',
    cardMask: '',
    login: access,
    target: cross ? target : resolvedMode === 'other' ? '' : access,
    hint: 'Gerando login…',
  };
  let msg = await editBubble(chatId, statusMsg, bubbleFields);

  try {
    let link;
    const row = getNumber(access);
    if (loginLink) {
      link = toLoginUrl(loginLink);
    } else if (row?.link) {
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
      const purge = await purgeLoginCards(chatId, msg, bubbleFields, {
        sessionId: session.id,
        msisdn: msisdnResolved,
        productId: valores[0].id,
      });
      walletAuth = purge.walletAuth;
      cardsPurged = purge.removed ?? 0;
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
      purgedAt: resolvedMode === 'other' ? Date.now() : null,
    });

    if (!valores.length) {
      await editBubble(chatId, msg, {
        ...bubbleFields,
        login: msisdnResolved,
        title: 'Sem valores',
        hint: 'Este login não tem recarga disponível',
      });
      return false;
    }

    clearRecharge(chatId);
    const readyFields = {
      ...bubbleFields,
      login: msisdnResolved,
      target: target || (resolvedMode === 'other' ? '' : msisdnResolved),
      title: skipValuePrompt ? 'Login pronto' : 'Escolha o valor',
      hint: skipValuePrompt
        ? 'Iniciando recarga…'
        : cardsPurged > 0
          ? `${cardsPurged} cartão(ões) removido(s) do login`
          : 'Toque no valor abaixo',
    };

    if (skipValuePrompt) {
      await editBubble(chatId, msg, readyFields);
      return true;
    }

    await editBubble(chatId, msg, readyFields, { reply_markup: buildValueKeyboard(valores) });
    return true;
  } catch (err) {
    await editBubble(chatId, msg, {
      ...bubbleFields,
      title: 'Erro',
      hint: formatFetchError(err),
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
  const epoch = bumpWork(chatId);
  busy.add(chatId);
  const statusMsg = await editBubble(chatId, null, {
    title: 'Preparando',
    login: '',
    hint: 'Gerando login aleatório…',
  });
  try {
    const { msisdn, link } = await generateLoginMsisdn({
      shouldAbort: () => isWorkStale(chatId, epoch),
    });
    if (isWorkStale(chatId, epoch)) return;
    await editBubble(chatId, statusMsg, {
      title: 'Preparando',
      login: msisdn,
      hint: 'Buscando valores…',
    });
    busy.delete(chatId);
    await prepareRechargeSession(chatId, msisdn, {
      statusMsg,
      mode: 'other',
      loginLink: link,
    });
  } catch (err) {
    if (err?.cancelled || isWorkStale(chatId, epoch)) return;
    await editBubble(chatId, statusMsg, {
      title: 'Erro',
      hint: formatFetchError(err),
    });
  } finally {
    busy.delete(chatId);
  }
}

async function promptCardLine(chatId) {
  await editBubble(chatId, null, {
    title: 'Cartão manual',
    hint: 'Envie NUMERO|MM|AAAA|CVV',
  });
}

function payMethodKeyboard(cards) {
  const pending = cardList.countPending();
  const inUse = cardList.countInUse();
  const label = inUse > 0 ? `${pending} fila · ${inUse} em uso` : `${pending}`;
  return buildPayMethodKeyboard(cards, { pendingCards: pending, queueLabel: label });
}

async function pickAutoCardLine(chatId) {
  const reserved = await cardList.reserveNextCard(chatId);
  if (!reserved?.card) return null;
  return { line: reserved.line, card: reserved.card, pan: reserved.pan };
}

async function executeAutoRecharge(chatId, { statusMsg = null } = {}) {
  const picked = await pickAutoCardLine(chatId);
  if (!picked) {
    const inUse = cardList.countInUse();
    await send(
      chatId,
      inUse > 0
        ? `❌ Nenhum cartão livre na fila (<b>${inUse}</b> em uso por outras sessões).\n\nAguarde ou use cartão manual.`
        : '❌ Lista <code>cards-pending.txt</code> vazia.\n\nEnvie um <b>.txt</b> com um cartão por linha:\n<code>NUMERO|MM|AAAA|CVV</code>',
    );
    return;
  }

  const flow = rechargeFlow.get(chatId);
  if (flow) {
    flow.autoPay = true;
    flow.cardListLine = picked.line;
    rechargeFlow.set(chatId, flow);
  }

  const entry = getCache(chatId);
  const msg = await editBubble(chatId, statusMsg, {
    title: 'Cartão',
    valueLabel: flow?.productName ?? '',
    cardMask: cardMaskFrom(picked.card),
    login: entry?.msisdn || flow?.loginMsisdn || '',
    target: flow?.rechargeTargetNumber || entry?.rechargeTargetNumber || entry?.msisdn || '',
    hint: 'Cartão da fila · processando…',
  });
  await executeRecharge(chatId, picked.card, { cardListLine: picked.line, statusMsg: msg });
}

/** Nova sessão para retry: novo login (modo other), mesmo destino/valor. */
async function prepareRetryRecharge(chatId, retry, statusMsg) {
  if (busy.has(chatId)) return null;
  busy.add(chatId);

  const maxPrep = 3;
  const retryBubble = {
    valueLabel: retry.productName ?? '',
    cardMask: '',
    login: retry.loginMsisdn || '',
    target: retry.targetMsisdn || '',
    title: 'Nova tentativa',
    hint: 'Preparando…',
  };
  try {
    for (let attempt = 1; attempt <= maxPrep; attempt++) {
      try {
        let access = retry.loginMsisdn;
        let prefetchedLink = null;
        if (retry.mode === 'other') {
          await editBubble(chatId, statusMsg, {
            ...retryBubble,
            title: 'Nova tentativa',
            hint: attempt === 1 ? 'Gerando novo login…' : `Rede instável · tentativa ${attempt}/${maxPrep}`,
          });
          const generated = await generateLoginMsisdn();
          access = generated.msisdn;
          prefetchedLink = generated.link;
          retryBubble.login = access;
        } else {
          await editBubble(chatId, statusMsg, {
            ...retryBubble,
            title: 'Nova tentativa',
            hint: attempt === 1 ? 'Reabrindo sessão…' : `Rede instável · tentativa ${attempt}/${maxPrep}`,
          });
        }

        const target = normalizeBrMobile(retry.targetMsisdn) || access;
        const cross = Boolean(target && access && target !== access);

        let link;
        const row = getNumber(access);
        if (prefetchedLink) {
          link = toLoginUrl(prefetchedLink);
        } else if (row?.link) {
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

        const product =
          valores.find((v) => v.id === retry.productId) ??
          valores.find((v) => v.value === retry.productValue);

        if (!product) {
          await editBubble(chatId, statusMsg, {
            ...retryBubble,
            login: msisdnResolved,
            title: 'Valor indisponível',
            hint: `${retry.productName} sumiu neste login`,
          });
          return null;
        }

        let walletAuth = null;
        const purge = await purgeLoginCards(chatId, statusMsg, retryBubble, {
          sessionId: session.id,
          msisdn: msisdnResolved,
          productId: product.id,
        });
        walletAuth = purge.walletAuth;

        setCache(chatId, {
          link,
          walletAuth,
          cards: [],
          sessionId: session.id,
          msisdn: msisdnResolved,
          rechargeTargetNumber: cross ? target : undefined,
          valores,
          rechargeMode: retry.mode,
          awaitTargetMsisdn: false,
        });

        chatRechargeMode.set(chatId, retry.mode);

        return { product, access: msisdnResolved, target };
      } catch (err) {
        if (attempt < maxPrep && isTransientFetchError(err)) {
          console.warn(`[bot][retry][prep] ${err.message} (${attempt}/${maxPrep})`);
          resetProxyAgent();
          await sleep(700 * attempt);
          continue;
        }
        await editBubble(chatId, statusMsg, {
          ...retryBubble,
          title: 'Erro no retry',
          hint: formatFetchError(err),
        });
        return null;
      }
    }
    return null;
  } finally {
    busy.delete(chatId);
  }
}

async function runRechargeRetry(chatId, messageId, { automatic = false } = {}) {
  const retry = rechargeRetry.get(chatId);
  if (!retry) {
    await send(chatId, '❌ Nada para tentar de novo. Use /start');
    return;
  }
  if (!automatic) resetRetryRound(chatId);

  if (busy.has(chatId)) {
    await send(chatId, '⏳ Aguarde a recarga anterior…');
    return;
  }

  const statusMsg = { message_id: messageId, chat: { id: chatId } };
  const retryN = automatic ? (retry.autoRetries || 0) + 1 : 0;
  const retryHint =
    retryN > 0
      ? `Retry automático ${retryN}/${MAX_AUTO_RECHARGE_RETRIES} · próximo cartão`
      : 'Mesmo valor e destino · próximo cartão';
  await editBubble(chatId, statusMsg, {
    title: retryN > 0 ? `Nova tentativa ${retryN}/${MAX_AUTO_RECHARGE_RETRIES}` : 'Nova tentativa',
    valueLabel: retry.productName ?? '',
    login: retry.loginMsisdn || '',
    target: retry.targetMsisdn || '',
    hint: retryHint,
  });

  const prep = await prepareRetryRecharge(chatId, retry, statusMsg);
  if (!prep) return;

  rechargeFlow.set(chatId, {
    mode: retry.mode,
    productId: prep.product.id,
    productValue: prep.product.value,
    productName: prep.product.name,
    rechargeTargetNumber: prep.target,
    autoPay: true,
  });

  const pending = cardList.countPending();
  if (pending > 0 || retry.useAuto !== false) {
    await editBubble(chatId, statusMsg, {
      title: 'Nova tentativa',
      valueLabel: prep.product.name,
      login: prep.access,
      target: prep.target,
      hint: 'Pegando próximo cartão da fila…',
    });
    await executeAutoRecharge(chatId, { statusMsg });
    return;
  }

  await editBubble(
    chatId,
    statusMsg,
    {
      title: 'Fila vazia',
      valueLabel: prep.product.name,
      login: prep.access,
      target: prep.target,
      hint: 'Envie cartões ou escolha manual',
    },
    { reply_markup: payMethodKeyboard([]) },
  );
  rechargeFlow.get(chatId).step = 'pick_card';
}

async function startQuickCrossAutoRecharge(chatId, { targetMsisdn, valueCents }) {
  const target = normalizeBrMobile(targetMsisdn);
  const cents = Number(valueCents);
  if (!target || !cents) {
    await send(chatId, '❌ Atalho inválido. Ex: <code>13991019331|Claro|30</code>');
    return;
  }

  preemptChatWork(chatId);
  resetRetryRound(chatId);
  clearDestBalance(chatId);

  if (cardList.countPending() === 0) {
    const inUse = cardList.countInUse();
    await send(
      chatId,
      inUse > 0
        ? `❌ Nenhum cartão livre na fila (<b>${inUse}</b> em uso).\n\nAguarde ou envie mais cartões.`
        : '❌ Fila automática vazia.\n\nEnvie cartões: <code>NUMERO|MM|AAAA|CVV</code>',
    );
    return;
  }

  const statusMsg = await editBubble(chatId, null, {
    title: 'Recarga automática',
    valueLabel: formatBRL(cents),
    target,
    hint: 'Gerando login…',
  });

  const epoch = bumpWork(chatId);
  let lastErr = null;

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    if (isWorkStale(chatId, epoch)) return;

    await editBubble(chatId, statusMsg, {
      title: 'Recarga automática',
      valueLabel: formatBRL(cents),
      target,
      hint: `Gerando login · tentativa ${attempt}`,
    }).catch(() => {});

    let generated;
    try {
      generated = await generateLoginMsisdn({
        shouldAbort: () => isWorkStale(chatId, epoch),
      });
    } catch (err) {
      if (err?.cancelled || isWorkStale(chatId, epoch)) return;
      lastErr = err;
      continue;
    }

    if (isWorkStale(chatId, epoch)) return;

    const ok = await prepareRechargeSession(chatId, generated.msisdn, {
      targetMsisdn: target,
      statusMsg,
      mode: 'other',
      loginLink: generated.link,
      skipValuePrompt: true,
    });
    if (!ok) {
      lastErr = new Error(`Login ${generated.msisdn} falhou`);
      continue;
    }

    const entry = getCache(chatId);
    const product = (entry?.valores || []).find((v) => Number(v.value) === cents);
    if (!product) {
      lastErr = new Error(`${formatBRL(cents)} não existe neste login gerado`);
      continue;
    }

    chatRechargeMode.set(chatId, 'other');
    rechargeFlow.set(chatId, {
      step: 'pick_card',
      mode: 'other',
      productId: product.id,
      productValue: product.value,
      productName: product.name,
      rechargeTargetNumber: target,
      autoPay: true,
    });

    await editBubble(chatId, statusMsg, {
      title: 'Recarga automática',
      valueLabel: product.name,
      login: entry.msisdn,
      target,
      hint: 'Pegando cartão da fila…',
    }).catch(() => {});

    await executeAutoRecharge(chatId, { statusMsg });
    return;
  }

  await editBubble(chatId, statusMsg, {
    title: 'Não iniciou',
    valueLabel: formatBRL(cents),
    target,
    hint: lastErr?.message || 'não gerou login com esse valor',
  }).catch(() => {});
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
  await editBubble(
    chatId,
    null,
    {
      title: 'Escolha o valor',
      login: entry.msisdn,
      target: entry.rechargeTargetNumber || entry.msisdn,
      hint: 'Toque no valor abaixo',
    },
    { reply_markup: buildValueKeyboard(entry.valores) },
  );
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
    await editBubble(chatId, { message_id: messageId }, {
      title: 'Quem recebe?',
      valueLabel: product.name,
      login: entry.msisdn,
      hint: 'Envie o número destino (11 dígitos)',
    });
    return;
  }

  const hasCards = entry.cards?.length > 0;
  const pendingCards = cardList.countPending();
  await editBubble(
    chatId,
    { message_id: messageId },
    {
      title: 'Forma de pagamento',
      valueLabel: product.name,
      login: entry.msisdn,
      target: flow.rechargeTargetNumber || entry.msisdn,
      hint: 'Automático ou cartão manual',
    },
    { reply_markup: payMethodKeyboard(entry.cards) },
  );

  if (!hasCards && pendingCards === 0) {
    rechargeFlow.set(chatId, {
      ...rechargeFlow.get(chatId),
      step: 'card_line',
    });
    await promptCardLine(chatId);
  }
}

async function executeRecharge(chatId, card, { cardListLine = null, statusMsg: incomingStatus = null } = {}) {
  const entry = getCache(chatId);
  const flow = rechargeFlow.get(chatId);
  let listLine = cardListLine ?? flow?.cardListLine ?? null;

  if (!entry?.sessionId || !flow?.productId) {
    if (listLine) await cardList.applyOutcome(listLine, 'return', '', chatId);
    await send(chatId, '❌ Sessão expirada. Comece de novo com /recarga');
    clearRecharge(chatId);
    return;
  }

  if (busy.has(chatId)) {
    if (listLine) await cardList.applyOutcome(listLine, 'return', '', chatId);
    await send(chatId, '⏳ Aguarde…');
    return;
  }
  if (!card.token && card.number) {
    const check = cardList.assertCardAvailable(card, chatId);
    if (!check.ok) {
      await send(chatId, `🔒 ${check.reason}`);
      return;
    }
    if (!listLine) {
      const adHoc = await cardList.reserveAdHocCard(chatId, card);
      if (!adHoc) {
        await send(chatId, '🔒 Cartão já em uso por outra sessão. Aguarde ou use outro.');
        return;
      }
      listLine = adHoc.line;
      flow.cardListLine = listLine;
      rechargeFlow.set(chatId, flow);
    }
  }

  busy.add(chatId);
  const useBrowser = isBrowserRechargeEnabled() && !card.token;
  const targetMsisdn = flow.rechargeTargetNumber || entry.rechargeTargetNumber || entry.msisdn;
  const startedAt = Date.now();
  let telegramUser = null;
  try {
    telegramUser = upsertTelegramUser({ id: chatId }, { incrementMessages: 0 });
  } catch {
    // ignore
  }

  if ((flow.mode === 'other' || entry.awaitTargetMsisdn) && !entry.rechargeTargetNumber) {
    busy.delete(chatId);
    if (listLine) await cardList.applyOutcome(listLine, 'return', '', chatId);
    await send(chatId, '❌ Informe o número destino antes do cartão (/start → Outro número).');
    clearRecharge(chatId);
    return;
  }

  const useHybrid = useBrowser && isHybridRechargeEnabled();
  const runBubble = {
    title: 'Processando',
    valueLabel: flow.productName ?? '',
    cardMask: cardMaskFrom(card),
    login: entry.msisdn,
    target: targetMsisdn || entry.msisdn,
    hint: 'Aguardando checkout…',
  };
  const statusMsg = await editBubble(chatId, incomingStatus, runBubble);
  const epochAtStart = workEpoch.get(chatId);
  let scheduledAutoRetry = false;
  let destBalanceText = '';

  try {
    const destKey = normalizeBrMobile(targetMsisdn);
    if (destKey) {
      let pack = destBalanceByChat.get(chatId);
      if (!pack?.before || pack.dest !== destKey) {
        await editBubble(chatId, statusMsg, {
          ...runBubble,
          hint: 'Consultando saldo do destino…',
        }).catch(() => {});
        const snap = await snapshotDestBalance(destKey, { sessionId: pack?.sessionId });
        pack = {
          dest: destKey,
          sessionId: snap.sessionId ?? null,
          before: snap.ok ? snap.balance : null,
          after: null,
          error: snap.ok ? null : snap.error,
        };
        destBalanceByChat.set(chatId, pack);
        if (snap.ok) {
          console.log(
            `[bot] saldo antes dest=${destKey} ${snap.balance.cents}c val=${snap.balance.expiration || '—'}`,
          );
        } else {
          console.warn(`[bot] saldo antes dest=${destKey} falhou: ${snap.error}`);
        }
      }
    }
    await editBubble(chatId, statusMsg, { ...runBubble, hint: 'Aguardando checkout…' }).catch(() => {});

    if (flow.mode === 'other' || entry.rechargeMode === 'other') {
      if (entry.purgedAt && Date.now() - entry.purgedAt < 120_000) {
        await editBubble(chatId, statusMsg, { ...runBubble, hint: 'Aguardando checkout…' }).catch(() => {});
      } else {
        const purge = await purgeLoginCards(chatId, statusMsg, runBubble, {
          sessionId: entry.sessionId,
          msisdn: entry.msisdn,
          productId: flow.productId,
        });
        if (purge.walletAuth) {
          entry.walletAuth = purge.walletAuth;
        }
        entry.purgedAt = Date.now();
        setCache(chatId, entry);
        await editBubble(chatId, statusMsg, { ...runBubble, hint: 'Aguardando checkout…' }).catch(() => {});
      }
    }

    let outcome = useBrowser
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

    if (isRechargeSuccess(outcome)) {
      await editBubble(chatId, statusMsg, {
        ...runBubble,
        title: 'Conferindo Claro',
        hint: 'Confirmando no histórico da operadora…',
      }).catch(() => {});
      const last4 = String(card?.number ?? '').replace(/\D/g, '').slice(-4);
      const confirm = await confirmClaroReload({
        sessionId: entry.sessionId,
        loginMsisdn: entry.msisdn,
        targetMsisdn,
        last4,
        startedAt,
      });
      if (confirm.status === 'nok') {
        console.warn(
          `[bot] Claro nok dest=${normalizeBrMobile(targetMsisdn) || targetMsisdn} last4=${last4} — Eldorado tinha CONFIRMED`,
        );
        outcome = applyClaroNokToOutcome(outcome, confirm);
      } else if (confirm.status === 'ok') {
        console.log(`[bot] Claro ok dest=${normalizeBrMobile(targetMsisdn) || targetMsisdn} last4=${last4}`);
      } else {
        console.warn(`[bot] Claro histórico incerto dest=${normalizeBrMobile(targetMsisdn) || targetMsisdn}: ${confirm.error || confirm.status}`);
      }
    }

    logRechargeEvent({
      chatId,
      username: telegramUser?.username ?? null,
      loginMsisdn: entry.msisdn,
      targetMsisdn,
      productName: flow.productName,
      productValueCents: flow.productValue,
      card,
      outcome,
      mode: useBrowser ? (useHybrid ? 'hybrid' : 'browser') : 'api',
      startedAt,
    });

    let queueFooter = '';
    if (listLine) {
      const action = classifyCardListAction({ outcome, error: null });
      const meta =
        action === 'return'
          ? ''
          : buildCardListArchiveMeta({ outcome, error: null, entry, targetMsisdn, flow, action });
      const applied = await cardList.applyOutcome(listLine, action, meta, chatId);
      queueFooter = formatQueueFooter(action, applied.pendingLeft);
    }

    const attemptLog = appendAttemptLog(
      chatId,
      summarizeRechargeAttempt({
        outcome,
        error: null,
        cardMask: cardMaskFrom(card),
      }),
    );
    const plan = planRechargeRetry(chatId, {
      flow,
      entry,
      targetMsisdn,
      listLine,
      outcome,
      error: null,
    });
    scheduledAutoRetry = plan.autoRetry;

    if (isRechargeSuccess(outcome) && destKey) {
      const pack = destBalanceByChat.get(chatId) || { dest: destKey };
      const afterSnap = await snapshotDestBalanceUntilChange(destKey, pack.before, {
        sessionId: pack.sessionId,
        onAttempt: ({ attempt, total, waitMs }) =>
          editBubble(chatId, statusMsg, {
            ...runBubble,
            title: 'Conferindo saldo',
            hint:
              attempt === 1
                ? 'Lendo saldo e validade após a recarga…'
                : `A API atrasou — nova leitura ${attempt}/${total} (${Math.round(waitMs / 1000)}s)…`,
          }).catch(() => {}),
      });
      pack.after = afterSnap.ok ? afterSnap.balance : null;
      pack.sessionId = afterSnap.sessionId ?? pack.sessionId;
      destBalanceByChat.set(chatId, pack);
      destBalanceText = formatBalanceCompare(pack.before, pack.after, {
        stale: afterSnap.ok && afterSnap.changed === false,
      });
      if (afterSnap.ok) {
        console.log(
          `[bot] saldo depois dest=${destKey} ${afterSnap.balance.cents}c val=${afterSnap.balance.expiration || '—'} tent=${afterSnap.attempts} mudou=${afterSnap.changed}`,
        );
      } else {
        console.warn(`[bot] saldo depois dest=${destKey} falhou: ${afterSnap.error}`);
        destBalanceText = formatBalanceCompare(pack.before, null);
      }
    }

    const resultPayload = {
      ...outcome,
      loginMsisdn: entry.msisdn,
      targetMsisdn,
    };
    const report = formatRechargeResult(resultPayload, {
      footer: queueFooter,
      attempts: attemptLog,
      balance: destBalanceText,
    });
    const retryKb = plan.showRetryButton
      ? buildRetryKeyboard({ autoAvailable: cardList.countPending() > 0 })
      : undefined;
    try {
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: report,
        parse_mode: 'HTML',
        reply_markup: retryKb,
      });
    } catch (err) {
      console.warn('[bot] resultado: edit falhou, enviando nova:', err.message);
      await send(chatId, report, { reply_markup: retryKb });
    }
  } catch (err) {
    logRechargeEvent({
      chatId,
      username: telegramUser?.username ?? null,
      loginMsisdn: entry.msisdn,
      targetMsisdn,
      productName: flow.productName,
      productValueCents: flow.productValue,
      card,
      error: err,
      mode: useBrowser ? (useHybrid ? 'hybrid' : 'browser') : 'api',
      startedAt,
    });

    let queueFooter = '';
    if (listLine) {
      const action = classifyCardListAction({ outcome: null, error: err });
      const meta =
        action === 'return'
          ? ''
          : buildCardListArchiveMeta({ outcome: null, error: err, entry, targetMsisdn, flow, action });
      const applied = await cardList.applyOutcome(listLine, action, meta, chatId);
      queueFooter = formatQueueFooter(action, applied.pendingLeft);
    }

    const attemptLog = appendAttemptLog(
      chatId,
      summarizeRechargeAttempt({
        outcome: null,
        error: err,
        cardMask: cardMaskFrom(card),
      }),
    );
    const plan = planRechargeRetry(chatId, {
      flow,
      entry,
      targetMsisdn,
      listLine,
      outcome: null,
      error: err,
    });
    scheduledAutoRetry = plan.autoRetry;
    const retryKb = plan.showRetryButton
      ? buildRetryKeyboard({ autoAvailable: cardList.countPending() > 0 })
      : undefined;
    const multi = attemptLog.length > 1;

    await editBubble(
      chatId,
      statusMsg,
      {
        ...runBubble,
        title: 'Erro na recarga',
        cardMask: multi ? '' : runBubble.cardMask,
        hint: multi ? '' : formatFetchError(err),
        attempts: multi ? formatAttemptLog(attemptLog) : '',
        subhint: queueFooter,
      },
      { reply_markup: retryKb },
    ).catch(() => {});
  } finally {
    busy.delete(chatId);
    clearRecharge(chatId);
  }

  if (scheduledAutoRetry && !isWorkStale(chatId, epochAtStart) && statusMsg?.message_id) {
    const n = rechargeRetry.get(chatId)?.autoRetries ?? 0;
    console.log(`[bot] auto-retry ${n}/${MAX_AUTO_RECHARGE_RETRIES} chat=${chatId}`);
    await sleep(400);
    if (isWorkStale(chatId, epochAtStart)) return;
    await runRechargeRetry(chatId, statusMsg.message_id, { automatic: true });
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
    await editBubble(
      chatId,
      null,
      {
        title: 'Forma de pagamento',
        valueLabel: flow.productName,
        login: entry.msisdn,
        target,
        hint: hasCards || pendingCards > 0 ? 'Automático ou cartão manual' : 'Envie os dados do cartão',
      },
      hasCards || pendingCards > 0 ? { reply_markup: payMethodKeyboard(entry.cards) } : undefined,
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

  if (query.from) {
    upsertTelegramUser(query.from);
    if (!isTelegramUserAllowed(chatId)) {
      await tg('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Acesso bloqueado.',
        show_alert: true,
      }).catch(() => {});
      return;
    }
  }

  await tg('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

  if (data === 'recarga:start') {
    await startRechargePicker(chatId);
    return;
  }

  if (data === 'rcgmode:same') {
    chatRechargeMode.set(chatId, 'same');
    await editBubble(chatId, { message_id: messageId }, {
      title: 'Mesmo número',
      hint: 'Envie o número (login e recarga nele)',
    }).catch(() =>
      editBubble(chatId, null, {
        title: 'Mesmo número',
        hint: 'Envie o número (login e recarga nele)',
      }),
    );
    return;
  }

  if (data === 'rcgmode:other') {
    await startOtherNumberRecharge(chatId);
    return;
  }

  if (data === 'rcg:cancel') {
    clearRecharge(chatId);
    await editBubble(chatId, { message_id: messageId }, {
      title: 'Cancelada',
      hint: 'Use /start para recomeçar',
    });
    return;
  }

  if (data === 'rcg:retry') {
    await runRechargeRetry(chatId, messageId);
    return;
  }

  if (data === 'rcg:home') {
    await promptRechargeMode(chatId);
    return;
  }

  if (data.startsWith('rcg:') && !['rcg:cancel', 'rcg:retry', 'rcg:home'].includes(data)) {
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
    resetRetryRound(chatId);
    clearDestBalance(chatId);
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
  const extracted = extractCardLinesFromText(text);
  const cardLines = extracted.lines;
  if (!cardLines.length) {
    await send(chatId, '❌ Nenhuma linha de cartão válida.\n\nFormato: <code>NUMERO|MM|AAAA|CVV</code>');
    return;
  }
  const result = await cardList.ingestText(cardLines.join('\n'));
  const leftover = extracted.truncated ? extracted.total - cardLines.length : 0;
  const lines = [
    '<b>💳 Cartões adicionados à fila</b>',
    leftover
      ? `⚠️ <b>${extracted.total}</b> linhas válidas — limite de <b>${MAX_CARD_LINES_PER_INGEST}</b> por envio. Ficaram de fora: <b>${leftover}</b>. Envie o restante em outro arquivo.`
      : `Linhas válidas no arquivo: <b>${extracted.total}</b>`,
    '',
    `✅ Novos: <b>${result.added}</b>`,
    result.duplicates
      ? `⏭ Duplicados (mesmo número): <b>${result.duplicates}</b>${
          result.duplicateLast4?.length
            ? ` — ${result.duplicateLast4.join(', ')}`
            : ''
        }`
      : null,
    result.invalid ? `⚠️ Linhas inválidas: <b>${result.invalid}</b>` : null,
    '',
    `Total na fila: <b>${result.total}</b>`,
    `Em uso agora: <b>${result.inUse ?? cardList.countInUse()}</b>`,
    `Aprovados (histórico): <b>${cardList.countApproved()}</b>`,
    `Consumidos (VBV/negada): <b>${cardList.countConsumed()}</b> (<code>cards-consumed.txt</code>)`,
    '',
    '<i>Duplicata = mesmo número já na fila, em uso ou em aprovados.</i>',
    '',
    'No pagamento, toque em <b>🤖 Automático</b>.',
  ].filter(Boolean);
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

/** Lista colada no chat (2+ cartões) ou cartão único fora do fluxo de recarga. */
async function tryIngestCardListFromMessage(chatId, text) {
  if (!text?.trim() || text.startsWith('/')) return false;

  const { lines: cardLines } = extractCardLinesFromText(text);
  if (cardLines.length >= 2) {
    await handleCardsTxtIngest(chatId, cardLines.join('\n'));
    return true;
  }

  if (cardLines.length === 1 && !rechargeFlow.has(chatId)) {
    await handleCardsTxtIngest(chatId, cardLines[0]);
    return true;
  }

  return false;
}

async function sendCartoesFila(chatId) {
  const pending = cardList.countPending();
  const approved = cardList.countApproved();
  const consumed = cardList.countConsumed();
  const inUse = cardList.countInUse();
  const next = cardList.peekPendingLine();
  let nextMask = '—';
  if (next) {
    const parsed = parseCardInput(next);
    if (parsed?.number) nextMask = formatCardMask(parsed.number);
  }
  await send(
    chatId,
    [
      '<b>🤖 Fila automática de cartões</b>',
      '',
      `Pendentes: <b>${pending}</b> (<code>cards-pending.txt</code>)`,
      `Em uso agora: <b>${inUse}</b> (<code>cards-reserved.json</code>)`,
      `Aprovados: <b>${approved}</b> (<code>cards-approved.txt</code>)`,
      `Consumidos: <b>${consumed}</b> (<code>cards-consumed.txt</code>)`,
      `Próximo: <code>${nextMask}</code>`,
      '',
      '🔒 Cada cartão reservado fica bloqueado para outros usuários até a recarga terminar.',
      '',
      '<b>Enviar cartões:</b>',
      '• Cole a lista no chat (várias linhas)',
      '• Ou mande um arquivo <b>.txt</b> / <code>cartoes.txt</code>',
      'Formato: <code>NUMERO|MM|AAAA|CVV</code> — uma linha por cartão',
      'Duplicatas pelo número são ignoradas automaticamente.',
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
    if (text === '/start' || text === '/help' || text.startsWith('/start@') || text.startsWith('/help@') || text === '/status' || text.startsWith('/status@')) {
      preemptChatWork(chatId);
    }

    if (msg.from) {
      upsertTelegramUser(msg.from);
      if (!isTelegramUserAllowed(chatId)) {
        await send(chatId, '🚫 Acesso bloqueado pelo administrador.');
        return;
      }
    }
    if (msg.document) {
      await handleTxtDocument(chatId, msg.document);
      return;
    }

    if (isPriorityRechargeText(text)) {
      preemptChatWork(chatId);
    }

    if (text && !text.startsWith('/')) {
      const ingested = await tryIngestCardListFromMessage(chatId, text);
      if (ingested) return;
    }

    const quickCross = parseQuickCrossRecharge(text);
    if (quickCross) {
      await startQuickCrossAutoRecharge(chatId, quickCross);
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

    if (/^\/(cancelar|cancel)(@|\s|$)/i.test(text)) {
      await send(chatId, '↩️ Fluxo cancelado. Envie a recarga ou /start.');
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
      // Sem modo (ex.: bot recém-iniciado) ou "outro número": varredura completa.
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
  let lastBeat = 0;
  while (true) {
    try {
      const updates = await tg(
        'getUpdates',
        {
          offset,
          timeout: 20,
          allowed_updates: ['message', 'callback_query'],
        },
        { timeoutMs: 45_000, retries: 1 },
      );

      const now = Date.now();
      if (now - lastBeat >= 30_000) {
        lastBeat = now;
        console.log(`[bot] poll ok · updates=${updates.length} · uptime=${Math.floor(process.uptime())}s`);
      }

      for (const update of updates) {
        offset = update.update_id + 1;
        const from = update.message?.from?.username || update.callback_query?.from?.username || '';
        const kind = update.message ? 'msg' : 'cb';
        console.log(`[bot] update ${kind} @${from} id=${update.update_id}`);
        if (update.message) {
          handleMessage(update.message).catch((e) => console.error('[msg]', e.message));
        }
        if (update.callback_query) {
          handleCallback(update.callback_query).catch((e) => console.error('[cb]', e.message));
        }
      }
    } catch (err) {
      const msg = String(err?.message || err);
      console.error('[bot] poll:', msg);
      await sleep(/409|conflict/i.test(msg) ? 1200 : 2000);
    }
  }
}

async function main() {
  const released = await cardList.releaseAllReservations();
  if (released.released) {
    console.log(`[bot] ${released.released} reserva(s) órfã(s) devolvida(s) à fila (${released.pendingLeft} pendente(s))`);
  }

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
