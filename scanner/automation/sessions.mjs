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
import { runWebLinkCheckoutPay, ensureSmartCheckoutReady } from './checkout.mjs';
import { waitForPaymentResult } from './gate.mjs';
import { prepareCheckoutViaHttp } from '../lib/prepare-checkout-http.mjs';
import { fetchWalletCards, deleteAllWalletCards, openWalletSession } from '../lib/eldorado.mjs';
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

export const getSessionPublic = (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return {
    sessionId: session.id,
    status: session.status,
    step: session.step,
    stepLabel: session.stepLabel,
    accessNumber: session.accessNumber,
    browserAlive: sessionPageAlive(session),
    paymentResult: session.paymentResult ?? null,
    lastError: session.lastError ?? null,
  };
};

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
  if (paymentResult?.status === '3ds_required' && config.keepBrowserOpen3dsSeconds > 0) {
    return Math.max(400, config.keepBrowserOpen3dsSeconds * 1000);
  }
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

    await cleanupUsedCard(session, paymentResult);
    await finalizeSessionClose(sessionId, paymentResult);

    return {
      sessionId,
      status: session.status,
      paymentResult,
      accessNumber,
      rechargeValue: payload.rechargeValue,
      browser: browserName,
      url: page.url(),
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
  const browserName = resolveBrowserName(payload);
  const accessNumber = normalizeBrMobile(payload?.accessNumber || payload?.claroNumber);
  const rechargeTargetNumber = normalizeBrMobile(
    payload?.rechargeTargetNumber || payload?.accessNumber || payload?.claroNumber,
  );
  if (!accessNumber || accessNumber.length !== 11) {
    throw new Error('accessNumber (DDD + 9 dígitos) é obrigatório.');
  }
  if (rechargeTargetNumber && rechargeTargetNumber !== accessNumber) {
    throw new Error('Recarga cruzada ainda não suportada no modo checkout-link.');
  }

  let loginUrl = String(payload?.loginUrl || payload?.link || '').trim();
  if (!loginUrl) throw new Error('loginUrl é obrigatório.');
  loginUrl = normalizeMinhaClaroWebLink(loginUrl) || loginUrl;

  const rechargeValue = String(payload?.rechargeValue ?? '').replace(/\D/g, '');
  if (!rechargeValue) throw new Error('rechargeValue é obrigatório.');

  const valueCents = Number(rechargeValue) * 100;
  const httpStarted = Date.now();
  const prep = await prepareCheckoutViaHttp({
    loginUrl,
    msisdn: accessNumber,
    valueCents,
  });
  prep.httpLatencyMs = Date.now() - httpStarted;
  console.log(
    `[automation] HTTP checkout pronto em ${prep.httpLatencyMs}ms → ${prep.checkoutUrl.slice(0, 80)}…`,
  );

  if (prep.bemobiToken && prep.checkoutCode) {
    try {
      const cardsRes = await fetchWalletCards(prep.bemobiToken, prep.checkoutCode);
      const saved = Array.isArray(cardsRes.body) ? cardsRes.body : [];
      if (saved.length) {
        console.log(
          `[automation] checkout-link: limpando ${saved.length} cartão(ões) salvos via HTTP…`,
        );
        await deleteAllWalletCards(prep.bemobiToken, prep.checkoutCode, saved);
        const wallet2 = await openWalletSession(prep.claroSessionId, accessNumber, prep.product.id);
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
    await page.goto(prep.checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissCookieBanner(page);
    await sleep(config.pauseAfterNavMs);

    if (!(await ensureSmartCheckoutReady(page, session))) {
      throw new Error('Checkout Eldorado não carregou após abrir URL direta.');
    }

    session.status = 'running';
    const payPayload = buildPamPayload(payload);
    await runWebLinkCheckoutPay(session, payPayload._pamParsed);
    setSessionStep(session, 'aguardando_gate', 'Aguardando retorno da gate…');
    console.log(
      `[automation] gate-wait (checkout-link) msisdn=${accessNumber} valor=R$${rechargeValue}`,
    );
    const paymentResult = await waitForPaymentResult(page, 120000, session.gateCapture, session);

    session.paymentResult = paymentResult;
    if (paymentResult?.status === 'success') {
      session.status = 'done';
    } else if (paymentResult?.status === '3ds_required') {
      session.status = '3ds_required';
    } else {
      session.status = 'error_manual';
    }

    await cleanupUsedCard(session, paymentResult);
    await finalizeSessionClose(sessionId, paymentResult);

    return {
      sessionId,
      status: session.status,
      paymentResult,
      accessNumber,
      rechargeValue: payload.rechargeValue,
      browser: browserName,
      url: page.url(),
      mode: 'checkout-link',
      httpPrep: {
        checkoutUrl: prep.checkoutUrl,
        checkoutCode: prep.checkoutCode,
        productName: prep.product?.name,
        httpLatencyMs: prep.httpLatencyMs,
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
