import { randomUUID } from 'node:crypto';
import {
  launchBrowser,
  createMobileContext,
  resolveBrowserName,
} from './browser.mjs';
import { config } from './config.mjs';
import { attachGateCapture } from './gate.mjs';
import {
  normalizeBrMobile,
  normalizeMinhaClaroWebLink,
  splitPamInfo,
  setSessionStep,
  waitForWebPortalAuth,
  dismissCookieBanner,
  sleep,
} from './helpers.mjs';
import { runWebLinkRecharge } from './web-flow.mjs';
import { runWebLinkCheckoutPay } from './checkout.mjs';
import { waitForCheckoutAntifraud } from './antifraud-browser.mjs';
import { waitForPaymentResult, waitForPaymentResultViaHttp, waitForPaymentIdFromGate } from './gate.mjs';
import { prepareCheckoutViaHttp } from '../lib/prepare-checkout-http.mjs';
import { proxyAllTraffic } from '../lib/proxy.mjs';
import {
  fetchWalletCards,
  deleteAllWalletCards,
  openWalletSession,
  unifySavedCards,
  deleteCardEverywhere,
} from '../lib/eldorado.mjs';
import { scanClaroEssential } from '../lib/claro.mjs';
import { stopVncIfIdle } from './vnc.mjs';
import { removeUsedCardAfterRecharge } from './card-cleanup.mjs';

const sessions = new Map();
let pendingBrowserSlots = 0;

export const countAliveSessions = () => {
  let n = 0;
  for (const session of sessions.values()) {
    if (sessionPageAlive(session)) n += 1;
  }
  return n;
};

export const getConcurrencyPublic = () => ({
  aliveSessions: countAliveSessions(),
  pendingSlots: pendingBrowserSlots,
  maxConcurrentSessions: config.maxConcurrentSessions,
});

export const sessionPageAlive = (session) => {
  try {
    if (!session?.page || session.page.isClosed()) return false;
    if (session.browser?.isConnected && !session.browser.isConnected()) return false;
    return true;
  } catch {
    return false;
  }
};

const acquireBrowserSlot = async (reason = 'start') => {
  const max = Math.max(1, config.maxConcurrentSessions || 3);
  const waitMs = Math.max(5000, config.sessionSlotWaitMs || 600000);
  const deadline = Date.now() + waitMs;
  while (true) {
    const alive = countAliveSessions();
    const used = alive + pendingBrowserSlots;
    if (used < max) {
      pendingBrowserSlots += 1;
      console.log(`[automation] vaga reservada (${used + 1}/${max}) — ${reason}`);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pendingBrowserSlots = Math.max(0, pendingBrowserSlots - 1);
      };
    }
    if (Date.now() > deadline) {
      throw new Error(`Limite de ${max} telas atingido. Aguarde e tente de novo.`);
    }
    await sleep(1500);
  }
};

export const closeSession = async (sessionId) => {
  clearSessionWatchdog(sessionId);
  const session = sessions.get(sessionId);
  if (!session) return { sessionId, closed: false };
  rememberSession({
    ...getSessionPublic(sessionId),
    browserAlive: false,
    closedAt: Date.now(),
  });
  session.closing = true;
  sessions.delete(sessionId);
  try {
    session.gateCapture?.detach?.();
  } catch {
    // ignore
  }
  let browserProc = null;
  try {
    browserProc = session.browser?.process?.() ?? null;
  } catch {
    // ignore
  }
  try {
    await session.context?.close();
  } catch {
    // ignore
  }
  try {
    await session.browser?.close();
  } catch {
    // ignore
  }
  if (browserProc?.pid && !browserProc.killed) {
    try {
      process.kill(browserProc.pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
  if (session.vncStarted) stopVncIfIdle();
  return { sessionId, closed: true };
};

export const closeAllSessions = async () => {
  const ids = [...sessions.keys()];
  const results = [];
  for (const id of ids) {
    results.push(await closeSession(id));
  }
  return { closed: results.filter((r) => r.closed).length, results };
};

export const closeSessionsByAccessNumber = async (accessNumber) => {
  const key = normalizeBrMobile(accessNumber);
  const ids = [];
  for (const [id, session] of sessions.entries()) {
    if (session.accessNumber === key) ids.push(id);
  }
  const results = [];
  for (const id of ids) results.push(await closeSession(id));
  return { closed: results.filter((r) => r.closed).length, results };
};

const sessionHistory = [];
const SESSION_HISTORY_MAX = 40;

export function slimPaymentResultForApi(pr) {
  if (!pr || typeof pr !== 'object') return pr ?? null;
  return {
    status: pr.status ?? null,
    gateCode: pr.gateCode ?? null,
    gateMessage: pr.gateMessage ?? null,
    message: pr.message ?? null,
    pagamentoErro: Boolean(pr.pagamentoErro),
    url: pr.url ?? null,
    threeDs: pr.threeDs
      ? {
          kind: pr.threeDs.kind ?? null,
          source: pr.threeDs.source ?? null,
          uiVisible: pr.threeDs.uiVisible ?? null,
        }
      : null,
    visualVbv: Boolean(pr.visualVbv),
    requiresImmediateAction: Boolean(pr.requiresImmediateAction),
  };
}

function slimPayment(pr) {
  if (!pr) return null;
  const body = pr.gateResponse?.body ?? {};
  const pay = Array.isArray(body.payments) ? body.payments[0] : null;
  return {
    status: pr.status ?? body.status ?? null,
    gateCode: pr.gateCode ?? body.status ?? null,
    message: pr.gateMessage ?? pr.message ?? null,
    nsu: pay?.nsu ?? null,
    auth: pay?.authorizationCode ?? null,
  };
}

function rememberSession(entry) {
  if (!entry?.sessionId) return;
  const idx = sessionHistory.findIndex((s) => s.sessionId === entry.sessionId);
  if (idx >= 0) sessionHistory.splice(idx, 1);
  sessionHistory.unshift(entry);
  if (sessionHistory.length > SESSION_HISTORY_MAX) sessionHistory.length = SESSION_HISTORY_MAX;
}

function applyPaymentOutcomeStep(session, paymentResult) {
  const st = String(paymentResult?.status ?? '').toLowerCase();
  if (st === 'success') {
    setSessionStep(session, 'sucesso', paymentResult.gateMessage || 'Pagamento confirmado');
    return;
  }
  if (st === '3ds_required') {
    setSessionStep(session, '3ds_required', paymentResult.gateMessage || '3DS — confirme no banco');
    return;
  }
  if (st === 'timeout') {
    setSessionStep(session, 'timeout', paymentResult.gateMessage || paymentResult.message || 'Timeout na gate');
    return;
  }
  setSessionStep(
    session,
    'erro_gate',
    paymentResult?.gateMessage || paymentResult?.message || session.lastError || 'Pagamento recusado',
  );
}

function publicStepFromSession(session) {
  const pay = String(session.paymentResult?.status ?? '').toLowerCase();
  const stuckGate = /aguardando_gate|aguardando retorno da gate/i.test(
    `${session.step || ''} ${session.stepLabel || ''}`,
  );
  if (stuckGate && pay === 'success') {
    return { step: 'sucesso', stepLabel: session.paymentResult?.gateMessage || 'Pagamento confirmado' };
  }
  if (stuckGate && pay === '3ds_required') {
    return { step: '3ds_required', stepLabel: session.paymentResult?.gateMessage || '3DS — confirme no banco' };
  }
  if (stuckGate && (pay === 'error' || session.status === 'error_manual')) {
    return { step: 'erro_gate', stepLabel: session.paymentResult?.gateMessage || session.lastError || 'Pagamento recusado' };
  }
  return { step: session.step, stepLabel: session.stepLabel };
}

export const getSessionPublic = (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const payment = slimPayment(session.paymentResult);
  const step = publicStepFromSession(session);
  return {
    sessionId: session.id,
    status: session.status,
    step: step.step,
    stepLabel: step.stepLabel,
    accessNumber: session.accessNumber,
    rechargeTargetNumber: session.rechargeTargetNumber ?? null,
    browserAlive: sessionPageAlive(session),
    paymentStatus: payment?.status ?? null,
    gateCode: payment?.gateCode ?? null,
    gateMessage: payment?.message ?? session.lastError ?? null,
    nsu: payment?.nsu ?? null,
    lastError: session.lastError ?? null,
    createdAt: session.createdAt ?? null,
    browserName: session.browserName ?? null,
    checkoutLinkMode: Boolean(session.checkoutLinkMode),
  };
};

export const listAllSessionsPublic = () => {
  const items = [];
  for (const session of sessions.values()) {
    const pub = getSessionPublic(session.id);
    items.push(pub);
    rememberSession(pub);
  }
  items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return items;
};

export const listRecentSessions = () => sessionHistory.slice();

const scheduleSessionClose = (sessionId, delayMs) => {
  const ms = Math.max(400, delayMs);
  console.log(`[automation] fechando Edge em ${ms}ms…`);
  setTimeout(() => {
    closeSession(sessionId).catch((err) => {
      console.error(`[automation] falha ao fechar ${sessionId}:`, err?.message || err);
    });
  }, ms);
};

const sessionCloseDelayMs = () => Math.max(400, (config.keepBrowserOpenSeconds || 0) * 1000);

const shouldKeepBrowserOpen = (paymentResult) => {
  if (paymentResult?.status === '3ds_required') return 0;
  if (config.keepBrowserOpenSeconds > 0) {
    return sessionCloseDelayMs();
  }
  return 0;
};

const sessionWatchdogs = new Map();

const clearSessionWatchdog = (sessionId) => {
  const t = sessionWatchdogs.get(sessionId);
  if (t) {
    clearTimeout(t);
    sessionWatchdogs.delete(sessionId);
  }
};

const armSessionWatchdog = (sessionId) => {
  const ms = config.sessionMaxLifetimeMs;
  if (!ms || ms <= 0) return;
  clearSessionWatchdog(sessionId);
  const timer = setTimeout(() => {
    sessionWatchdogs.delete(sessionId);
    if (!sessions.has(sessionId)) return;
    console.log(
      `[automation] watchdog: sessão ${sessionId.slice(0, 8)}… excedeu ${Math.round(ms / 1000)}s — fechando Edge`,
    );
    closeSession(sessionId).catch((err) => {
      console.error(`[automation] watchdog falhou ${sessionId}:`, err?.message || err);
    });
  }, ms);
  timer.unref?.();
  sessionWatchdogs.set(sessionId, timer);
};

const finalizeSessionClose = async (sessionId, paymentResult) => {
  clearSessionWatchdog(sessionId);
  const keepMs = shouldKeepBrowserOpen(paymentResult);
  if (keepMs <= 0) {
    console.log(`[automation] fechando Edge agora (${paymentResult?.status || 'done'})…`);
    await closeSession(sessionId).catch((err) => {
      console.error(`[automation] falha ao fechar ${sessionId}:`, err?.message || err);
    });
    return;
  }
  scheduleSessionClose(sessionId, keepMs);
};

const cleanupUsedCard = async (session, paymentResult) => {
  if (!session?.pamTouchCommitted && !session?.gateCapture?.captures?.length) return;
  await removeUsedCardAfterRecharge(session, paymentResult).catch((err) => {
    console.log(`[automation][card] cleanup: ${String(err?.message || err).slice(0, 120)}`);
  });
};

const finishPaymentSession = async (sessionId, session, paymentResult, { gateMode = 'browser' } = {}) => {
  const is3ds = paymentResult?.status === '3ds_required';
  if (is3ds && gateMode === 'browser') {
    console.log('[automation][3ds] fechando Edge na hora — cleanup do cartão em background');
    await finalizeSessionClose(sessionId, paymentResult);
    void cleanupUsedCard(session, paymentResult).catch((err) => {
      console.log(`[automation][3ds] cleanup async: ${String(err?.message || err).slice(0, 100)}`);
    });
    return;
  }

  await cleanupUsedCard(session, paymentResult);
  if (gateMode === 'browser') {
    await finalizeSessionClose(sessionId, paymentResult);
  }
};

/** Aguarda cleanup do cartão e fechamento do Edge antes de liberar a resposta da API. */
const scheduleFinishPaymentSession = async (sessionId, session, paymentResult, opts = {}) => {
  const { gateMode = 'browser' } = opts;
  await finishPaymentSession(sessionId, session, paymentResult, { gateMode });
};

const buildPamPayload = (payload) => {
  const pamRaw = String(payload?.pamInfo ?? '').trim();
  if (!pamRaw) throw new Error('pamInfo é obrigatório (PAN|MES|ANO|CVV).');
  const pam = splitPamInfo(pamRaw);
  return { ...payload, pamInfo: pamRaw, _pamParsed: pam };
};

/**
 * Abre link JWT minhaclaro_web no Edge (sem SMS) e executa recarga até o resultado.
 */
export const startSessionFromWebLink = async (payload) => {
  const browserName = resolveBrowserName(payload);
  const accessNumber = normalizeBrMobile(payload?.accessNumber || payload?.claroNumber);
  const rechargeTargetNumber = normalizeBrMobile(
    payload?.rechargeTargetNumber || payload?.accessNumber || payload?.claroNumber,
  );
  if (!accessNumber || accessNumber.length !== 11) {
    throw new Error('accessNumber (DDD + 9 dígitos) é obrigatório.');
  }

  let loginUrl = String(payload?.loginUrl || payload?.link || '').trim();
  if (!loginUrl) throw new Error('loginUrl é obrigatório.');
  loginUrl = normalizeMinhaClaroWebLink(loginUrl) || loginUrl;

  if (config.closeAllSessionsOnStart) {
    const prev = await closeAllSessions().catch(() => ({ closed: 0 }));
    if (prev?.closed) {
      console.log(`[automation] ${prev.closed} sessão(ões) Edge fechada(s) antes da nova recarga`);
    }
  } else {
    // Paralelo: só encerra sessão anterior do mesmo número (evita duplicata no mesmo JWT).
    await closeSessionsByAccessNumber(accessNumber).catch(() => {});
  }

  const releaseSlot = await acquireBrowserSlot(`weblink:${accessNumber}`);
  let browser = null;
  let sessionId;
  let session;
  try {
    browser = await launchBrowser(browserName);
    const context = await createMobileContext(browser);
    const page = await context.newPage();
    const gateCapture = attachGateCapture(context);

    sessionId = randomUUID();
    session = {
      id: sessionId,
      browser,
      context,
      page,
      gateCapture,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: 'created',
      browserName,
      accessNumber,
      rechargeTargetNumber,
      webPortal: true,
      webLoginUrl: loginUrl,
      pamTouchCommitted: false,
      smsAuthenticated: false,
    };
    sessions.set(sessionId, session);
    armSessionWatchdog(sessionId);
    releaseSlot();
  } catch (err) {
    releaseSlot();
    try {
      await browser?.close();
    } catch {
      // ignore
    }
    throw err;
  }

  const { page } = session;
  try {
    setSessionStep(session, 'open_web_link', 'Abrindo link JWT no Edge…');
    console.log(`[automation] goto ${loginUrl.slice(0, 90)}…`);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissCookieBanner(page);
    await sleep(config.pauseAfterNavMs);

    if (!(await waitForWebPortalAuth(page))) {
      throw new Error(`Login JWT não completou. url=${page.url() || '?'}`);
    }

    session.smsAuthenticated = true;
    session.status = 'running';

    if (!payload?.rechargeValue) {
      session.status = 'ready_retry';
      setSessionStep(session, 'ready_retry', 'Logado via JWT — aguardando pagamento.');
      return {
        sessionId,
        status: session.status,
        link: loginUrl,
        accessNumber,
        browser: browserName,
        url: page.url(),
      };
    }

    const payPayload = buildPamPayload(payload);
    let paymentResult;
    try {
      paymentResult = await runWebLinkRecharge(session, payPayload);
    } catch (err) {
      session.status = 'error_manual';
      session.lastError = String(err?.message || err);
      await cleanupUsedCard(session, { status: 'error' });
      await finalizeSessionClose(sessionId, { status: 'error' });
      throw err;
    }

    session.paymentResult = paymentResult;
    if (paymentResult?.status === 'success') {
      session.status = 'done';
    } else if (paymentResult?.status === '3ds_required') {
      session.status = '3ds_required';
    } else {
      session.status = 'error_manual';
    }
    applyPaymentOutcomeStep(session, paymentResult);

    const replyUrl = (() => {
      try {
        return page.url();
      } catch {
        return loginUrl;
      }
    })();
    console.log('[automation] finalizando sessão (cartão + Edge) antes de responder API…');
    await scheduleFinishPaymentSession(sessionId, session, paymentResult);

    return {
      sessionId,
      status: session.status,
      paymentResult: slimPaymentResultForApi(paymentResult),
      accessNumber,
      rechargeValue: payload.rechargeValue,
      browser: browserName,
      url: replyUrl,
    };
  } catch (err) {
    session.status = 'error_manual';
    session.lastError = String(err?.message || err);
    setSessionStep(session, 'erro', session.lastError);
    await cleanupUsedCard(session, { status: 'error' });
    if (sessionPageAlive(session)) await finalizeSessionClose(sessionId, { status: 'error' });
    throw err;
  }
};

/**
 * HTTP prepara checkout (SmartCheckout) → Edge abre só a URL Eldorado e paga.
 */
export const startSessionFromCheckoutLink = async (payload) => {
  const runStarted = Date.now();
  const timings = {};
  const browserName = resolveBrowserName(payload);
  const accessNumber = normalizeBrMobile(payload?.accessNumber || payload?.claroNumber);
  const rechargeTargetNumber = normalizeBrMobile(
    payload?.rechargeTargetNumber || payload?.accessNumber || payload?.claroNumber,
  );
  if (!accessNumber || accessNumber.length !== 11) {
    throw new Error('accessNumber (DDD + 9 dígitos) é obrigatório.');
  }
  const crossNumber = rechargeTargetNumber && rechargeTargetNumber !== accessNumber;
  if (crossNumber) {
    console.log(
      `[automation] checkout-link cruzado: login=${accessNumber} → destino=${rechargeTargetNumber}`,
    );
  }

  let loginUrl = String(payload?.loginUrl || payload?.link || '').trim();
  if (!loginUrl) throw new Error('loginUrl é obrigatório.');
  loginUrl = normalizeMinhaClaroWebLink(loginUrl) || loginUrl;

  const rechargeValue = String(payload?.rechargeValue ?? '').replace(/\D/g, '');
  if (!rechargeValue) throw new Error('rechargeValue é obrigatório.');

  const valueCents = Number(rechargeValue) * 100;
  const fast = config.checkoutLinkFast;

  if (config.closeAllSessionsOnStart) {
    const prev = await closeAllSessions().catch(() => ({ closed: 0 }));
    if (prev?.closed) {
      console.log(`[automation] ${prev.closed} sessão(ões) Edge fechada(s) antes da nova recarga`);
    }
  } else {
    await closeSessionsByAccessNumber(accessNumber).catch(() => {});
  }

  const releaseSlot = await acquireBrowserSlot(`checkout-link:${accessNumber}`);
  let browser = null;
  let sessionId;
  let session;

  const browserStarted = Date.now();
  const browserPromise = launchBrowser(browserName).then(async (b) => {
    const context = await createMobileContext(b);
    const page = await context.newPage();
    return { browser: b, context, page, browserMs: Date.now() - browserStarted };
  });

  const httpStarted = Date.now();
  const prepPromise = (async () => {
    const prep = await prepareCheckoutViaHttp({
      loginUrl,
      msisdn: accessNumber,
      targetMsisdn: rechargeTargetNumber,
      valueCents,
    });
    prep.httpLatencyMs = Date.now() - httpStarted;
    console.log(
      `[automation] HTTP checkout pronto em ${prep.httpLatencyMs}ms → ${prep.checkoutUrl.slice(0, 80)}…`,
    );

    if (prep.bemobiToken && prep.checkoutCode) {
      try {
        const cardsRes = await fetchWalletCards(prep.bemobiToken, prep.checkoutCode);
        const claroEssential = await scanClaroEssential(prep.claroSessionId, accessNumber, {
          includeProducts: false,
        }).catch(() => null);
        const saved = unifySavedCards(
          Array.isArray(cardsRes.body) ? cardsRes.body : [],
          claroEssential?.paymentMethods?.body,
        );
        if (saved.length) {
          console.log(
            `[automation] checkout-link: limpando ${saved.length} cartão(ões) salvos via HTTP…`,
          );
          await deleteAllWalletCards(prep.bemobiToken, prep.checkoutCode, saved);
          for (const card of saved) {
            await deleteCardEverywhere({
              bemobiToken: prep.bemobiToken,
              checkoutCode: prep.checkoutCode,
              sessionId: prep.claroSessionId,
              msisdn: accessNumber,
              cardToken: card.token,
            }).catch(() => {});
          }
          const wallet2 = await openWalletSession(prep.claroSessionId, accessNumber, prep.product.id, {
            payerMsisdn: accessNumber,
            recipient: rechargeTargetNumber,
          });
          if (wallet2.error) {
            console.log(
              `[automation] checkout-link: URL não regenerada após limpar wallet: ${wallet2.message ?? wallet2.error}`,
            );
          } else {
            prep.checkoutUrl = wallet2.checkoutUrl;
            prep.checkoutCode = wallet2.checkoutCode;
            prep.bemobiToken = wallet2.bemobiToken;
            console.log('[automation] checkout-link: URL checkout regenerada (wallet limpa)');
          }
        }
      } catch (err) {
        console.log(
          `[automation] checkout-link: falha ao limpar wallet: ${String(err?.message || err).slice(0, 100)}`,
        );
      }
    }
    return prep;
  })();

  let prep = null;
  try {
    const [prepResult, browserPack] = await Promise.all([prepPromise, browserPromise]);
    prep = prepResult;
    timings.httpPrepMs = prep.httpLatencyMs;
    timings.browserMs = browserPack.browserMs;
    browser = browserPack.browser;
    const gateCapture = attachGateCapture(browserPack.context);

    sessionId = randomUUID();
    session = {
      id: sessionId,
      browser,
      context: browserPack.context,
      page: browserPack.page,
      gateCapture,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: 'created',
      browserName,
      accessNumber,
      rechargeTargetNumber,
      webPortal: false,
      checkoutLinkMode: true,
      checkoutUrl: prep.checkoutUrl,
      httpPrep: prep,
      pamTouchCommitted: false,
      smsAuthenticated: true,
    };
    sessions.set(sessionId, session);
    armSessionWatchdog(sessionId);
    releaseSlot();
  } catch (err) {
    releaseSlot();
    try {
      await browser?.close();
    } catch {
      // ignore
    }
    throw err;
  }

  const { page } = session;
  try {
    setSessionStep(session, 'open_checkout_link', 'Abrindo checkout Eldorado (HTTP→browser)…');
    console.log(`[automation] goto checkout ${prep.checkoutUrl.slice(0, 90)}…`);
    const navStarted = Date.now();
    await page.goto(prep.checkoutUrl, {
      waitUntil: fast && !proxyAllTraffic() ? 'commit' : 'domcontentloaded',
      timeout: 45000,
    });
    timings.navMs = Date.now() - navStarted;
    if (!fast) {
      await dismissCookieBanner(page);
      await sleep(config.pauseAfterNavMs);
    }
    if (config.antifraudHumanFill) {
      const afHits = await waitForCheckoutAntifraud(page);
      timings.antifraudWaitMs = config.antifraudWaitMs;
      if (afHits) console.log(`[automation] antifraud fingerprint ok (${afHits} req)`);
    }

    session.status = 'running';
    const payPayload = buildPamPayload(payload);
    const payStarted = Date.now();
    await runWebLinkCheckoutPay(session, payPayload._pamParsed);
    timings.checkoutPayMs = Date.now() - payStarted;

    setSessionStep(session, 'aguardando_gate', 'Aguardando retorno da gate…');
    console.log(
      `[automation] gate-wait (checkout-link) msisdn=${accessNumber} valor=R$${rechargeValue}`,
    );
    const gateStarted = Date.now();
    const checkoutUrl = prep.checkoutUrl;
    const bemobiToken =
      session.gateCapture?.checkoutCtx?.bemobiToken || prep.bemobiToken || null;
    let paymentResult;
    let gateMode = 'browser';

    if (config.checkoutLinkHttpGate) {
      gateMode = 'http-sse';
      const idWaitStarted = Date.now();
      const idResult = await waitForPaymentIdFromGate(
        session.gateCapture,
        config.checkoutLinkPaymentIdWaitMs,
      );
      timings.paymentIdWaitMs = Date.now() - idWaitStarted;

      const gateSnapshot = {
        captures: session.gateCapture.captures,
        checkoutCtx: { ...(session.gateCapture.checkoutCtx ?? {}) },
        best: () => session.gateCapture.best(),
      };
      console.log('[automation] checkout-link: fechando Edge — gate via HTTP SSE…');
      session.gateCapture?.detach?.();
      clearSessionWatchdog(sessionId);
      await closeSession(sessionId);

      paymentResult = await waitForPaymentResultViaHttp(gateSnapshot, bemobiToken, checkoutUrl, {
        idResult,
      });
      session.gateCapture = gateSnapshot;
      timings.browserClosedBeforeGate = true;
    } else {
      paymentResult = await waitForPaymentResult(page, 120000, session.gateCapture, session, {
        pollMs: fast ? config.checkoutLinkGatePollMs : undefined,
      });
    }

    timings.gateMs = Date.now() - gateStarted;
    timings.gateMode = gateMode;
    timings.totalMs = Date.now() - runStarted;
    console.log(
      `[automation] timings checkout-link ms=${JSON.stringify(timings)}`,
    );

    session.paymentResult = paymentResult;
    if (paymentResult?.status === 'success') {
      session.status = 'done';
    } else if (paymentResult?.status === '3ds_required') {
      session.status = '3ds_required';
    } else {
      session.status = 'error_manual';
    }
    applyPaymentOutcomeStep(session, paymentResult);

    const replyUrl = gateMode === 'http-sse'
      ? checkoutUrl
      : (() => {
          try {
            return page.url();
          } catch {
            return checkoutUrl;
          }
        })();
    console.log('[automation] finalizando sessão (cartão + Edge) antes de responder API…');
    await scheduleFinishPaymentSession(sessionId, session, paymentResult, { gateMode });

    return {
      sessionId,
      status: session.status,
      paymentResult: slimPaymentResultForApi(paymentResult),
      accessNumber,
      rechargeValue: payload.rechargeValue,
      browser: browserName,
      url: replyUrl,
      mode: gateMode === 'http-sse' ? 'checkout-link-http' : 'checkout-link',
      timings,
      httpPrep: {
        checkoutUrl: session.httpPrep?.checkoutUrl,
        checkoutCode: session.httpPrep?.checkoutCode,
        productName: session.httpPrep?.product?.name,
        httpLatencyMs: session.httpPrep?.httpLatencyMs,
      },
    };
  } catch (err) {
    session.status = 'error_manual';
    session.lastError = String(err?.message || err);
    setSessionStep(session, 'erro', session.lastError);
    await cleanupUsedCard(session, { status: 'error' });
    if (sessionPageAlive(session)) await finalizeSessionClose(sessionId, { status: 'error' });
    throw err;
  }
};

export { sessions };
