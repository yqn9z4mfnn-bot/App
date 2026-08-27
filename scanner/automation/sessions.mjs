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
  const session = sessions.get(sessionId);
  if (!session) return { sessionId, closed: false };
  session.closing = true;
  sessions.delete(sessionId);
  try {
    session.gateCapture?.detach?.();
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
  return { sessionId, closed: true };
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
  setTimeout(() => {
    closeSession(sessionId).catch((err) => {
      console.error(`[automation] falha ao fechar ${sessionId}:`, err?.message || err);
    });
  }, delayMs);
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

  await closeSessionsByAccessNumber(accessNumber).catch(() => {});

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
      scheduleSessionClose(sessionId, 1500);
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

    const closeMs =
      paymentResult?.status === '3ds_required'
        ? 1500
        : Math.max(1500, (config.keepBrowserOpenSeconds || 5) * 1000);
    scheduleSessionClose(sessionId, closeMs);

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
    if (sessionPageAlive(session)) scheduleSessionClose(sessionId, 1500);
    throw err;
  }
};

export { sessions };
