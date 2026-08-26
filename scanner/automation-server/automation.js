import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { chromium, firefox, devices } from "playwright";
import { v4 as uuidv4 } from "uuid";
import { config, getStepDelay } from "./config.js";
import {
  claimNextPamFromInfo,
  claimSpecificPamFromInfo,
  finalizePamLedger,
  normalizePamLine,
  returnPamToInfo
} from "./pamLedger.js";
import { generateWebLoginLink, normalizeMinhaClaroWebLink } from "./linkGenerate.js";
import {
  tryApiDirectEldoradoPay,
  isGateRequestCaptureUrl,
  gateCaptureHas3dsChallenge
} from "./apiPayPoc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLARO_DEBUG_DIR = path.join(__dirname, "..", "debug");

const sessions = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isNlogPortal = () => /minhaclaro_app_nlog/i.test(config.landingUrl || config.baseUrl || "");
const WEB_PORTAL = "https://clarorecarga.claro.com.br/minhaclaro_web";
const isWebPortalSession = (session) => Boolean(session?.webPortal);
const webPortalPath = (suffix) => `${WEB_PORTAL}/${String(suffix || "").replace(/^\//, "")}`;
const meusDadosFor = (session) =>
  isWebPortalSession(session) ? webPortalPath("meus-dados") : config.meusDadosUrl;
const pagamentoErroFor = (session) =>
  isWebPortalSession(session) ? webPortalPath("pagamento-erro") : config.pagamentoErroUrl;
const isPaymentErrorUrl = (url) => /pagamento-erro/i.test(String(url || ""));
const isPaymentSuccessUrl = (url) =>
  /pagamento-sucesso|confirmacao-beneficio|\/sucesso/i.test(String(url || "")) ||
  String(url || "").includes(config.pagamentoSucessoUrl || "");
const cardManagementUrl = (session) => meusDadosFor(session);
const gateBlob = (paymentResult) =>
  [
    paymentResult?.gateCode,
    paymentResult?.gateMessage,
    paymentResult?.message,
    JSON.stringify(paymentResult?.gateResponse?.body || "")
  ]
    .filter(Boolean)
    .join(" ");

const touchSession = (session) => {
  if (!session) return;
  session.lastActivityAt = Date.now();
};

/** Atualiza etapa visível no painel (polling GET /api/session/:id). */
const setSessionStep = (session, step, label) => {
  if (!session) return;
  session.step = step;
  session.stepLabel = label;
  session.stepAt = new Date().toISOString();
  session.steps = Array.isArray(session.steps) ? session.steps : [];
  session.steps.push({ step, label, at: session.stepAt });
  if (session.steps.length > 40) session.steps.splice(0, session.steps.length - 40);
  touchSession(session);
  console.log(`[claro][step] ${step}: ${label}`);
};

const SESSION_AUTH_DIR = path.join(__dirname, "..", "sessions");
const SESSION_ID_DIR = path.join(SESSION_AUTH_DIR, "id");

const authStatePathFor = (accessNumber) =>
  path.join(SESSION_AUTH_DIR, `${accessNumber}.json`);
const authMetaPathFor = (accessNumber) =>
  path.join(SESSION_AUTH_DIR, `${accessNumber}.meta.json`);
const authIdMapPathFor = (sessionId) => path.join(SESSION_ID_DIR, `${sessionId}.json`);

const findLiveSessionByAccess = (accessNumber) => {
  const key = normalizeBrMobile(accessNumber);
  if (!key) return null;
  for (const session of sessions.values()) {
    if (session.accessNumber === key && session.smsAuthenticated && session.status !== "done") {
      return session;
    }
  }
  return null;
};

const sessionPageAlive = (session) => {
  try {
    if (!session?.page || session.page.isClosed()) return false;
    if (session.browser && typeof session.browser.isConnected === "function" && !session.browser.isConnected()) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

const dropDeadSession = async (session) => {
  if (!session?.id) return;
  sessions.delete(session.id);
  try {
    session.gateCapture?.detach?.();
    session.m4uAuthCapture?.detach?.();
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
};

/** Reservas entre "vaga OK" e browser entrar no Map (evita estourar o limite). */
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
  sessionSlotWaitMs: config.sessionSlotWaitMs,
  sessionIdleTimeoutSeconds: config.sessionIdleTimeoutSeconds || null
});

export const listSessionsPublic = () => {
  const out = [];
  for (const session of sessions.values()) {
    const pub = getSessionPublic(session.id);
    if (pub) out.push(pub);
  }
  out.sort((a, b) => (b.idleForSeconds || 0) - (a.idleForSeconds || 0));
  return out;
};

export const closeAllSessions = async () => {
  const ids = [...sessions.keys()];
  const results = [];
  for (const id of ids) {
    try {
      results.push(await closeSession(id));
    } catch (err) {
      results.push({ sessionId: id, closed: false, error: String(err?.message || err) });
    }
  }
  return { closed: results.filter((r) => r.closed).length, results };
};

/**
 * Espera até haver vaga (< MAX_CONCURRENT_SESSIONS telas abertas).
 * onWait(label) opcional para atualizar step da sessão.
 * Retorna releaseSlot() — chamar se o launch falhar antes de registrar a sessão.
 */
const acquireBrowserSlot = async (reason = "start", onWait = null) => {
  const max = Math.max(1, config.maxConcurrentSessions || 5);
  const waitMs = Math.max(5000, config.sessionSlotWaitMs || 600000);
  const deadline = Date.now() + waitMs;
  let lastLog = 0;

  while (true) {
    const alive = countAliveSessions();
    const used = alive + pendingBrowserSlots;
    if (used < max) {
      pendingBrowserSlots += 1;
      console.log(`[claro] vaga de tela reservada (${alive}+${pendingBrowserSlots - 1} pend → ${used + 1}/${max}) — ${reason}`);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pendingBrowserSlots = Math.max(0, pendingBrowserSlots - 1);
      };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Limite de ${max} telas atingido (${alive} abertas). Aguarde alguma sessão liberar e tente de novo.`
      );
    }
    const msg = `Fila: ${alive}/${max} telas abertas — aguardando liberar…`;
    if (typeof onWait === "function") onWait(msg);
    if (Date.now() - lastLog > 5000) {
      console.log(`[claro] ${msg} (${reason})`);
      lastLog = Date.now();
    }
    await sleep(1500);
  }
};

const reservePamForSession = (session, payload) => {
  const fromBody = String(payload?.pamInfo ?? "").trim();
  let pamRaw = fromBody;
  if (pamRaw && pamRaw.includes("|")) {
    claimSpecificPamFromInfo(pamRaw);
  } else {
    pamRaw = claimNextPamFromInfo();
  }
  if (!pamRaw || !String(pamRaw).includes("|")) {
    throw new Error(
      "Nenhum PAM disponível em info.txt (PAN|MES|ANO). Adicione cartões no Gerenciador de Info."
    );
  }
  payload.pamInfo = pamRaw;
  session.claimedPam = pamRaw;
  session.pamClaimedAt = Date.now();
  return pamRaw;
};

const releaseUnusedPam = (session) => {
  if (!session?.claimedPam) return;
  if (session.pamTouchCommitted) return;
  try {
    returnPamToInfo(session.claimedPam);
  } catch (err) {
    console.warn(`[claro][pam] falha ao devolver PAM: ${err?.message || err}`);
  }
  session.claimedPam = null;
};

const authExpiredError = (page, session, detail = "") => {
  const url = page?.url?.() || "";
  const extra = detail ? ` ${detail}` : "";
  if (session?.smsAuthenticated || session?.restoredFromDisk) {
    return new Error(
      `Sessão Claro expirou — voltou ao login. O navegador precisa permanecer aberto após o SMS; se fechou ou a API reiniciou, é preciso um novo SMS.${extra} url=${url}`
    );
  }
  return new Error(
    `Código SMS inválido ou sessão expirada — voltou para a tela inicial (número vazio).${extra} url=${url}`
  );
};

export const getSessionPublic = (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const idleSec = config.sessionIdleTimeoutSeconds;
  const last = session.lastActivityAt || session.createdAt || Date.now();
  const idleMs = Math.max(0, Date.now() - last);
  const browserAlive = sessionPageAlive(session);
  return {
    sessionId: session.id,
    status: session.status,
    step: session.step || null,
    stepLabel: session.stepLabel || null,
    stepAt: session.stepAt || null,
    steps: Array.isArray(session.steps) ? session.steps.slice(-12) : [],
    accessNumber: session.accessNumber || null,
    rechargeTargetNumber: session.rechargeTargetNumber || null,
    browser: session.browserName || null,
    browserAlive,
    lastError: session.lastError || null,
    smsAuthenticated: Boolean(session.smsAuthenticated),
    canRetryWithoutSms: Boolean(session.smsAuthenticated && session.status !== "done"),
    authStatePath: session.authStatePath || null,
    idleTimeoutSeconds: idleSec > 0 ? idleSec : null,
    idleForSeconds: Math.floor(idleMs / 1000)
  };
};

const isWaitingSmsSession = (session) =>
  session?.status === "waiting_code" ||
  session?.step === "waiting_sms" ||
  /aguardando.*sms|waiting_sms/i.test(String(session?.stepLabel || ""));

/** GET /api/session — se browser morreu aguardando SMS, remove sessão fantasma. */
export const cleanupSessionIfBrowserDead = async (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session || sessionPageAlive(session)) return false;
  if (!isWaitingSmsSession(session)) return false;
  console.warn(`[claro] sessão ${sessionId} navegador fechado aguardando SMS — limpando`);
  await dropDeadSession(session);
  return true;
};

const persistAuthState = async (session) => {
  syncM4uOkFromCapture(session);
  session.smsAuthenticated = true;
  try {
    await fs.mkdir(SESSION_AUTH_DIR, { recursive: true });
    await fs.mkdir(SESSION_ID_DIR, { recursive: true });
    const key = session.accessNumber || session.id;
    const file = authStatePathFor(key);
    const state = await session.context.storageState();
    await fs.writeFile(file, JSON.stringify(state, null, 0), "utf8");
    session.authStatePath = file;
    const meta = {
      sessionId: session.id,
      accessNumber: session.accessNumber || null,
      rechargeTargetNumber: session.rechargeTargetNumber || null,
      webPortal: Boolean(session.webPortal),
      savedAt: new Date().toISOString()
    };
    await fs.writeFile(authMetaPathFor(key), JSON.stringify(meta, null, 0), "utf8");
    if (session.id) {
      await fs.writeFile(authIdMapPathFor(session.id), JSON.stringify(meta, null, 0), "utf8");
    }
    console.log(`[claro] storageState salvo (retry sem SMS): ${file}`);
  } catch (err) {
    console.warn(`[claro] nao foi possivel salvar storageState: ${err?.message || err}`);
  }
};

const resolveAccessNumberForRestore = async (sessionId, payload) => {
  const fromPayload = normalizeBrMobile(payload?.accessNumber || payload?.claroNumber);
  if (fromPayload && fromPayload.length === 11) return fromPayload;

  try {
    const raw = await fs.readFile(authIdMapPathFor(sessionId), "utf8");
    const meta = JSON.parse(raw);
    const fromId = normalizeBrMobile(meta?.accessNumber);
    if (fromId && fromId.length === 11) return fromId;
  } catch {
    // ignore
  }

  // Fallback: meta por telefone que aponta para este sessionId
  try {
    const entries = await fs.readdir(SESSION_AUTH_DIR);
    for (const name of entries) {
      if (!name.endsWith(".meta.json")) continue;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(SESSION_AUTH_DIR, name), "utf8"));
        if (meta?.sessionId === sessionId) {
          const n = normalizeBrMobile(meta.accessNumber);
          if (n && n.length === 11) return n;
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return null;
};

/**
 * Reabre navegador com storageState do disco (API reiniciou / browser fechou).
 * Mantém o mesmo sessionId quando possível.
 */
const restoreSessionFromDisk = async (sessionId, payload = {}) => {
  const accessNumber = await resolveAccessNumberForRestore(sessionId, payload);
  if (!accessNumber) {
    throw new Error(
      "Sessão não encontrada. Reinicie o passo 1 com o mesmo número — se o login Claro ainda valer, use Retry sem SMS após restaurar."
    );
  }

  const stateFile = authStatePathFor(accessNumber);
  try {
    await fs.access(stateFile);
  } catch {
    throw new Error(
      `Sessão não encontrada e sem login salvo para ${accessNumber}. Precisa de novo SMS.`
    );
  }

  let meta = {};
  try {
    meta = JSON.parse(await fs.readFile(authMetaPathFor(accessNumber), "utf8"));
  } catch {
    // ignore
  }

  const browserName = resolveBrowserName(payload);
  console.log(`[claro] Restaurando sessão autenticada do disco: ${accessNumber} (${stateFile})`);
  const releaseSlot = await acquireBrowserSlot(`restore:${accessNumber}`);
  let browser = null;
  let restoredId = sessionId || meta.sessionId || uuidv4();
  let session;
  try {
    browser = await launchBrowser(browserName);
    const context = await browser.newContext({
      ...devices["iPhone 12"],
      viewport: {
        width: config.mobileViewportWidth,
        height: config.mobileViewportHeight
      },
      storageState: stateFile
    });
    const page = await context.newPage();
    session = {
      id: restoredId,
      browser,
      context,
      page,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "ready_retry",
      browserName,
      accessNumber,
      rechargeTargetNumber: normalizeBrMobile(
        payload?.rechargeTargetNumber || meta.rechargeTargetNumber || accessNumber
      ),
      claroNumber: accessNumber,
      pamTouchCommitted: false,
      smsAuthenticated: true,
      authStatePath: stateFile,
      restoredFromDisk: true,
      webPortal: Boolean(meta.webPortal)
    };
    sessions.set(restoredId, session);
    attachClaroNetworkHooks(context, session);
    releaseSlot();
    ensureIdleSweep();
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
    setSessionStep(session, "restore_disk", "Restaurando login salvo (sem SMS)…");
    await page.goto(config.baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await dismissCookieBanner(page);
    await sleep(1500);

    // storageState sozinho costuma NÃO manter o token Claro — exige UI autenticada de verdade.
    const authed = await waitForAuthenticatedUi(page, 10000);
    if (!authed) {
      throw authExpiredError(
        page,
        session,
        "Login salvo no disco não é mais válido (token Claro expirou)."
      );
    }
    await persistAuthState(session);
    setSessionStep(session, "ready_retry", "Sessão restaurada — pronto para retry sem SMS");
    return session;
  } catch (err) {
    if (sessions.has(restoredId)) {
      try {
        await closeSession(restoredId);
      } catch {
        // ignore
      }
    }
    throw err;
  }
};

const getOrRestoreSession = async (sessionId, payload = {}) => {
  let session = sessions.get(sessionId);
  if (session && sessionPageAlive(session)) return session;
  if (session && !sessionPageAlive(session)) {
    console.warn(`[claro] sessão ${sessionId} com navegador fechado — tentando restaurar do disco`);
    await dropDeadSession(session);
  }

  const accessHint = normalizeBrMobile(payload?.accessNumber || payload?.claroNumber);
  if (accessHint) {
    const live = findLiveSessionByAccess(accessHint);
    if (live && sessionPageAlive(live)) return live;
    if (live && !sessionPageAlive(live)) await dropDeadSession(live);
  }

  return restoreSessionFromDisk(sessionId, payload);
};

/** Confirma exclusão só se o diálogo for de CARTÃO — nunca de cadastro/conta. */
const confirmCardDeleteDialog = async (page) => {
  const decision = await page.evaluate(() => {
    const dialog =
      document.querySelector('[role="dialog"], [aria-modal="true"], .modal, .MuiDialog-root, .mdn-Modal') ||
      [...document.querySelectorAll("div, section")].find((el) => {
        const t = (el.innerText || "").replace(/\s+/g, " ").trim();
        return (
          t.length > 8 &&
          t.length < 600 &&
          /excluir|remover|deseja|confirma/i.test(t) &&
          /cart[aã]o|cadastro|conta|perfil/i.test(t)
        );
      });
    if (!dialog) return { kind: "none" };
    const text = (dialog.innerText || "").replace(/\s+/g, " ").trim();
    const isCadastro =
      /excluir\s+cadastro|remover\s+cadastro|apagar\s+cadastro|excluir\s+conta|excluir\s+perfil|excluir\s+dados/i.test(
        text
      ) && !/cart[aã]o/i.test(text);
    const isCard = /cart[aã]o/i.test(text) && !isCadastro;
    const clickLabel = (labels) => {
      const btns = [...dialog.querySelectorAll("button, a, [role='button']")];
      for (const label of labels) {
        const re = new RegExp(`^\\s*${label}\\s*$`, "i");
        const btn = btns.find((b) => re.test((b.innerText || "").trim()));
        if (btn) {
          btn.click();
          return label;
        }
      }
      return null;
    };
    if (isCadastro) {
      clickLabel(["Não", "Nao", "Cancelar", "Fechar", "Voltar"]);
      return { kind: "cadastro", text: text.slice(0, 160) };
    }
    if (isCard) {
      const clicked = clickLabel(["Sim", "Confirmar", "OK", "Excluir cartão", "Excluir cartao", "Excluir", "Remover"]);
      return { kind: "card", clicked, text: text.slice(0, 160) };
    }
    // Diálogo ambíguo sem "cartão" — não confirma (evita apagar cadastro).
    clickLabel(["Não", "Nao", "Cancelar", "Fechar", "Voltar"]);
    return { kind: "ambiguous", text: text.slice(0, 160) };
  });

  if (decision.kind === "cadastro" || decision.kind === "ambiguous") {
    console.warn(
      `[claro] diálogo de exclusão IGNORADO (${decision.kind}): ${decision.text || "(sem texto)"}`
    );
    await sleep(400);
    return false;
  }
  if (decision.kind === "card") {
    await sleep(700);
    await closeSnackbarIfVisible(page);
    return true;
  }

  // Sem modal detectado → deixa o caller tentar fallback (Sim/Confirmar no mdn-Modal).
  return false;
};

/** Lista negativa (recipient / customermsisdn / …): excluir cadastro Claro Recarga (não confundir com exclusão de cartão). */
const confirmCadastroDeleteDialog = async (page) => {
  const ok = await page.evaluate(() => {
    const dialog =
      document.querySelector('[role="dialog"], [aria-modal="true"], .modal, .MuiDialog-root, .mdn-Modal') ||
      [...document.querySelectorAll("div, section")].find((el) => {
        const t = (el.innerText || "").replace(/\s+/g, " ").trim();
        return t.length > 10 && t.length < 800 && /excluir|cadastro|conta/i.test(t);
      });
    if (!dialog) return false;
    const text = (dialog.innerText || "").replace(/\s+/g, " ").trim();
    if (!/excluir.*cadastro|excluir.*conta|excluir.*perfil/i.test(text)) return false;
    if (/cart[aã]o/i.test(text) && !/cadastro|conta/i.test(text)) return false;
    const btns = [...dialog.querySelectorAll("button, a, [role='button']")];
    const sim = btns.find((b) =>
      /^(sim|confirmar|excluir|remover|ok)$/i.test((b.innerText || "").trim())
    );
    if (sim) {
      sim.click();
      return true;
    }
    return false;
  });
  if (ok) await sleep(900);
  return ok;
};

const purgeAuthStateOnDisk = async (accessNumber) => {
  const key = normalizeBrMobile(accessNumber);
  if (!key) return;
  for (const f of [authStatePathFor(key), authMetaPathFor(key)]) {
    try {
      await fs.unlink(f);
    } catch {
      // ignore
    }
  }
};

const excluirCadastroClaro = async (session, motivo = "limpeza") => {
  const { page } = session;
  if (!page || page.isClosed?.()) return false;
  setSessionStep(session, "excluir_cadastro", `Excluindo cadastro Claro (${motivo})…`);
  try {
    await dismissCookieBanner(page);
    const hasExcluirBtn = await visibleTextMatch(page, /Excluir meu cadastro|Excluir cadastro/i);
    if (!hasExcluirBtn) {
      if (isNlogPortal()) {
        await page.goto(config.meusDadosUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await sleep(600);
      } else {
        await refreshDadosTabAfterCardCleanup(page, session);
      }
    }
    const clicked = await clickByText(
      page,
      ["Excluir meu cadastro", "Excluir cadastro", "Excluir meu Cadastro"],
      15000
    );
    if (!clicked) {
      await saveStepDebug(page, "excluir_cadastro_fail");
      console.warn(`[claro] botão Excluir meu cadastro não encontrado (${motivo})`);
      return false;
    }
    await sleep(700);
    if (!(await confirmCadastroDeleteDialog(page))) {
      await clickByText(page, ["Sim", "Confirmar", "Excluir", "Remover"], 8000).catch(() => {});
    }
    await sleep(1200);
    await purgeAuthStateOnDisk(session.accessNumber);
    session.cadastroVerificado = false;
    session.cadastroExcluido = true;
    markAuthLost(session);
    console.log(`[claro] cadastro excluído (${motivo}): ${session.accessNumber || "?"}`);
    return true;
  } catch (err) {
    console.warn(`[claro] falha ao excluir cadastro (${motivo}): ${err?.message || err}`);
    await saveStepDebug(page, "excluir_cadastro_erro");
    return false;
  }
};

/** Lista negativa (recipient / customermsisdn / …): excluir cadastro Claro Recarga. */
const excluirCadastroClaroPosListaNegativa = async (session) =>
  excluirCadastroClaro(session, "lista negativa");

/**
 * Remove UM cartão já vinculado na aba Dados.
 * UI Claro atual: linha com brand_*.svg + "**** **** **** 1234" + <img> lixeira (não é <button>).
 * Nunca clica em "Excluir meu cadastro" nem na lixeira de "Outros números".
 */
const tryRemoveOneCard = async (page) => {
  // 1) Texto explícito de cartão (se existir).
  if (
    await clickByText(
      page,
      ["Excluir cartão", "Excluir cartao", "Remover cartão", "Remover cartao"],
      1500
    )
  ) {
    await sleep(500);
    return confirmCardDeleteDialog(page);
  }

  // 2) Lixeira <img> ao lado do PAN mascarado (fluxo real da Claro).
  const iconClicked = await page.evaluate(() => {
    const norm = (t) => (t || "").replace(/\s+/g, " ").trim();
    const isPhone = (t) => /\(\d{2}\)\s*\d{4,5}-?\d{4}/.test(t || "");
    const isMaskedPan = (t) =>
      /\*{4}\s+\*{4}\s+\*{4}\s+\d{4}/.test(t || "") ||
      /\*{4}\s*\*{4}\s*\*{4}\s*\d{4}/.test(t || "") ||
      /•{4}\s+•{4}\s+•{4}\s+\d{4}/.test(t || "");
    const isBrandImg = (img) => /brand_|visa|master|amex|elo|hiper/i.test(img.getAttribute("src") || "");
    const isCadastroControl = (el) =>
      /excluir\s+meu\s+cadastro|excluir\s+cadastro|remover\s+cadastro/i.test(norm(el.innerText || el.textContent || ""));

    // Âncora: textos de PAN mascarado.
    const panNodes = [...document.querySelectorAll("div, span, p, li")].filter((el) => {
      const t = norm(el.innerText || el.textContent);
      if (!t || t.length > 40) return false;
      if (isPhone(t)) return false;
      return isMaskedPan(t);
    });

    for (const panEl of panNodes) {
      // Linha do cartão: sobe poucos níveis até achar a lixeira (img sem brand_).
      let row = panEl;
      for (let up = 0; up < 5 && row; up += 1) {
        const imgs = [...row.querySelectorAll("img")].filter((img) => !isBrandImg(img));
        // Preferir img à direita do PAN (lixeira), não logo da bandeira.
        const trash = imgs.find((img) => {
          if (isCadastroControl(img) || isCadastroControl(img.parentElement || img)) return false;
          const src = img.getAttribute("src") || "";
          // Lixeira costuma ser data:image/png ou ícone pequeno; nunca brand_*.
          if (/brand_/i.test(src)) return false;
          return true;
        });
        if (trash) {
          // Não apagar se a linha for claramente um telefone.
          const rowText = norm(row.innerText || "");
          if (isPhone(rowText) && !isMaskedPan(rowText)) {
            row = row.parentElement;
            continue;
          }
          (trash.closest("button, a, [role='button']") || trash).click();
          return `img-lixeira:${rowText.slice(0, 40)}`;
        }
        row = row.parentElement;
      }
    }

    // Fallback: botões com label de cartão.
    for (const el of document.querySelectorAll("button, a, [role='button']")) {
      const label = norm(
        `${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`
      );
      if (/excluir\s+cart|remover\s+cart/i.test(label) && !/cadastro/i.test(label)) {
        el.click();
        return "label-cartao";
      }
    }
    return null;
  });

  if (!iconClicked) return false;
  console.log(`[claro] clique exclusão cartão via ${iconClicked}`);
  await sleep(600);
  const confirmed = await confirmCardDeleteDialog(page);
  if (!confirmed) {
    // Alguns fluxos abrem modal sem a palavra "cartão" — confirma só se não for cadastro.
    const forced = await page.evaluate(() => {
      const dialog =
        document.querySelector('[role="dialog"], [aria-modal="true"], .mdn-Modal, .modal') ||
        [...document.querySelectorAll("div")].find((el) => {
          const t = (el.innerText || "").replace(/\s+/g, " ").trim();
          return t.length > 10 && t.length < 500 && /deseja|excluir|remover|confirma/i.test(t);
        });
      if (!dialog) return "no-dialog";
      const text = (dialog.innerText || "").replace(/\s+/g, " ").trim();
      if (/excluir\s+meu\s+cadastro|excluir\s+cadastro|apagar\s+cadastro/i.test(text)) {
        const cancel = [...dialog.querySelectorAll("button, a")].find((b) =>
          /^(n[aã]o|cancelar|fechar|voltar)$/i.test((b.innerText || "").trim())
        );
        cancel?.click();
        return "cancelled-cadastro";
      }
      const ok = [...dialog.querySelectorAll("button, a")].find((b) =>
        /^(sim|confirmar|ok|excluir|remover)$/i.test((b.innerText || "").trim())
      );
      if (ok) {
        ok.click();
        return "confirmed";
      }
      return "no-button";
    });
    console.log(`[claro] confirm exclusão cartão (fallback): ${forced}`);
    if (forced !== "confirmed" && forced !== "no-dialog") return false;
  }
  await sleep(800);
  await closeSnackbarIfVisible(page);
  return true;
};

const removeExistingCardsIfAny = async (page, session) => {
  setSessionStep(session, "limpar_cartoes", "Removendo cartões já vinculados…");
  let removed = 0;
  // Contas podem ter vários cartões; tenta até limpar ou estagnar.
  for (let i = 0; i < 15; i += 1) {
    const before = await page.evaluate(() => {
      const t = document.body?.innerText || "";
      return (t.match(/\*{4}\s+\*{4}\s+\*{4}\s+\d{4}/g) || []).length;
    });
    if (before === 0) break;

    const ok = await tryRemoveOneCard(page);
    if (!ok) {
      console.warn(`[claro] falha ao remover cartão (restam ~${before})`);
      await saveStepDebug(page, "limpar_cartoes_fail");
      break;
    }
    removed += 1;
    await sleep(700);
    // Espera a lista atualizar.
    await sleep(400);
  }
  if (removed > 0) {
    setSessionStep(session, "limpar_cartoes_ok", `${removed} cartão(ões) removido(s)`);
    // Claro não redesenha "Cadastrar novo cartão" na hora — precisa sair e voltar na aba.
    await refreshDadosTabAfterCardCleanup(page, session);
  } else {
    const still = await page.evaluate(() => {
      const t = document.body?.innerText || "";
      return (t.match(/\*{4}\s+\*{4}\s+\*{4}\s+\d{4}/g) || []).length;
    });
    if (still > 0) {
      setSessionStep(
        session,
        "limpar_cartoes_fail",
        `${still} cartão(ões) visíveis mas lixeira não clicável`
      );
      await saveStepDebug(page, "limpar_cartoes_still_full");
    } else {
      setSessionStep(session, "limpar_cartoes_skip", "Nenhum cartão para remover");
    }
  }
  return removed;
};

/**
 * Após pagamento OK: apaga o cartão (GG) da conta Claro Recarga.
 * Best-effort — não invalida o sucesso se a lixeira falhar.
 */
const removeCardAfterSuccessfulPay = async (session) => {
  if (isWebPortalSession(session)) {
    return 0;
  }
  const { page } = session;
  if (!page || page.isClosed?.()) return 0;
  setSessionStep(session, "limpar_cartao_pos_sucesso", "Removendo cartão da conta após sucesso…");
  try {
    // Sai da tela pagamento-sucesso → home autenticada → aba Dados → lixeira
    const homeOk =
      (await hasAuthenticatedUiMarkers(page)) ||
      (await clickByText(page, ["Fazer recarga", "Outras Opções", "Recarga"], 8000));
    if (!homeOk) {
      await page.goto(cardManagementUrl(session), {
        waitUntil: "domcontentloaded",
        timeout: Math.min(config.navTimeoutMs || 30000, 20000)
      }).catch(() => {});
      await sleep(800);
    }
    await refreshDadosTabAfterCardCleanup(page, session);
    const removed = await removeExistingCardsIfAny(page, session);
    if (removed > 0) {
      setSessionStep(
        session,
        "limpar_cartao_pos_sucesso_ok",
        `${removed} cartão(ões) removido(s) após sucesso`
      );
    }
    return removed;
  } catch (err) {
    console.warn(`[claro] limpar cartão pós-sucesso: ${err?.message || err}`);
    setSessionStep(session, "limpar_cartao_pos_sucesso_fail", String(err?.message || err).slice(0, 120));
    return 0;
  }
};

/**
 * Após apagar cartões, a UI às vezes não mostra "Cadastrar novo cartão"
 * até mudar de aba e voltar (Recarga → Dados) ou recarregar Meus Dados.
 */
const refreshDadosTabAfterCardCleanup = async (page, session) => {
  if (session && isWebPortalSession(session)) {
    return;
  }
  setSessionStep(session, "refresh_dados", "Atualizando aba Dados (Recarga → Dados)…");
  await closeSnackbarIfVisible(page);
  await dismissCookieBanner(page);

  const wentRecarga = await clickRecargaTab(page);
  if (wentRecarga) {
    await sleep(900);
    await dismissCookieBanner(page);
  }

  const wentDados =
    (await clickByText(page, ["Dados"], 12000)) ||
    (await page.getByRole("tab", { name: /^Dados$/i }).first().click({ timeout: 5000 }).then(() => true).catch(() => false));

  if (!wentDados) {
    // Fallback: abre de novo a rota de Meus Dados.
    try {
      const url = page.url() || "";
      const target = /meus-dados|pagamento-cartao/i.test(url)
        ? url
        : cardManagementUrl(session);
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
      await sleep(1000);
    } catch (err) {
      console.warn(`[claro] refresh Dados via URL falhou: ${err?.message || err}`);
    }
  } else {
    await sleep(1000);
  }

  await closeSnackbarIfVisible(page);
  await dismissCookieBanner(page);

  // Se ainda não apareceu o cadastro, um reload costuma liberar o botão.
  const opt = await inspectNewCardOption(page);
  if (!opt.found || !opt.enabled) {
    setSessionStep(session, "refresh_dados_reload", "Recarregando Meus Dados…");
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
      await sleep(1200);
      await dismissCookieBanner(page);
      // Garante aba Dados após reload.
      await clickByText(page, ["Dados"], 8000);
      await sleep(700);
    } catch (err) {
      console.warn(`[claro] reload Meus Dados falhou: ${err?.message || err}`);
    }
  }
};

const VALID_BROWSERS = new Set(["chrome", "edge", "firefox", "chromium"]);

/** URLs/JSON da rede que parecem resposta de pagamento / gate. */
const GATE_URL_RE =
  /pagamento|payment|autoriz|authorize|charge|checkout|transac|recarga|purchase|billing|wallet|card|cartao|nsu|adyen|cielo|getnet|erede|pagarme|stone|worldpay|cybersource|braintree|gateway/i;
const GATE_SKIP_URL_RE =
  /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|map|ico)(\?|$)|hotjar|google-analytics|googletagmanager|facebook\.net|doubleclick|newrelic|nr-data|cookielaw|onetrust|adsct|twitter\.com|\/sms-tokens\/|\/sessions\/(\?|$)/i;
/** Telemetria / feature flags — não entra na gate nem no log. */
const GATE_TELEMETRY_URL_RE =
  /\/loop\/public\/events|\/v1\/features\/|cardinalcommerce\.com|eldorado\.m4u\.com\.br\/v1\/(?:ip|bins)|auth\/braspag\/brand|\/tmp\/token|unt\.mp\.plat-m4u\.io|google\.com\/gmp|adservice\.google|events\/checkout|src\.mastercard\.com|auth\.visa\.com|secure\.checkout\.visa\.com|secure-devicefp\.visa\.com/i;
const GATE_BODY_KEYS_RE =
  /returnCode|responseCode|authori[sz]ationCode|nsu|tid|returnMessage|errorMessage|errorCode|codigoRetorno|codRetorno|mensagem|message|statusCode|paymentStatus|transactionStatus|resultado|deny|declin|recus/i;

const deepFindStrings = (value, out, depth = 0) => {
  if (depth > 6 || value == null) return;
  if (typeof value === "string") {
    const t = value.trim();
    if (t) out.push(t);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40)) deepFindStrings(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (GATE_BODY_KEYS_RE.test(k) || /msg|erro|error|code|status|reason|descr/i.test(k)) {
        deepFindStrings(v, out, depth + 1);
      } else if (depth < 3) {
        deepFindStrings(v, out, depth + 1);
      }
    }
  }
};

const parseGateReason = (reason) => {
  const s = String(reason || "").trim();
  if (!s) return { code: null, message: null };
  const m = s.match(/-\s*(\d+)\s*-\s*(.+)$/i);
  if (m) return { code: m[1], message: m[2].trim() };
  return { code: null, message: s };
};

const parseSseJson = (text) => {
  const line = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:"));
  if (!line) return null;
  const raw = line.replace(/^data:\s*/, "");
  if (!raw.startsWith("{") && !raw.startsWith("[")) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const pickGateFields = (body) => {
  if (!body || typeof body !== "object") return { code: null, message: null, nsu: null };
  if (body._raw && typeof body._raw === "string") {
    const sse = parseSseJson(body._raw);
    if (sse) return pickGateFields(sse);
  }

  const pay0 = Array.isArray(body.payments) ? body.payments[0] : null;
  const denied =
    /^DENIED$/i.test(String(body.status || "")) ||
    /^DENIED$/i.test(String(pay0?.status || ""));
  if (denied) {
    const reason = pay0?.negativeReason || body.negativeReason || pay0?.standardCode || "";
    const parsed = parseGateReason(reason);
    return {
      code: parsed.code || pay0?.standardCode || "DENIED",
      message: reason || parsed.message || null,
      nsu: pay0?.transactionId ? String(pay0.transactionId) : null
    };
  }

  const confirmed =
    /^CONFIRMED$/i.test(String(body.status || "")) ||
    /^CONFIRMED$/i.test(String(pay0?.status || ""));
  if (confirmed) {
    const auth = pay0?.authorizationCode || pay0?.authorization_code;
    return {
      code: "CONFIRMED",
      message: auth ? `auth=${auth}` : body.message || null,
      nsu: pay0?.nsu != null ? String(pay0.nsu) : body.nsuPayment != null ? String(body.nsuPayment) : null
    };
  }

  const tx = body.tags?.transaction || body.transaction;
  if (tx && (tx.reason || /^DENIED$/i.test(String(tx.status || "")))) {
    const parsed = parseGateReason(tx.reason);
    return {
      code: parsed.code || (/^DENIED$/i.test(String(tx.status || "")) ? "DENIED" : null),
      message: parsed.message || tx.reason || null,
      nsu: null
    };
  }
  if (/^DENIED$/i.test(String(body.tags?.status || ""))) {
    const parsed = parseGateReason(body.tags?.transaction?.reason);
    return {
      code: parsed.code || "DENIED",
      message: parsed.message || body.tags?.transaction?.reason || null,
      nsu: null
    };
  }

  if (Array.isArray(body) && body.length) {
    const latest = body[0];
    if (latest && typeof latest === "object") {
      const pm = latest.paymentMethod || {};
      const st = String(latest.status || "").trim();
      return {
        code: st || null,
        message: pm.authorization_code ? `auth=${pm.authorization_code}` : null,
        nsu: pm.nsu != null ? String(pm.nsu) : null
      };
    }
  }

  if (body.data?.errors?.[0]) {
    const e = body.data.errors[0];
    const nested = e.detail && typeof e.detail === "object" ? e.detail : null;
    if (nested?.code) {
      const nestedDetail = nested.detail ?? nested.message ?? null;
      return {
        code: String(nested.code),
        message: nestedDetail != null ? String(nestedDetail) : null,
        nsu: null
      };
    }
    return {
      code: e.code || null,
      message: typeof e.detail === "string" ? e.detail : e.message || null,
      nsu: null
    };
  }

  const codeKeys = [
    "returnCode",
    "responseCode",
    "errorCode",
    "codigoRetorno",
    "codRetorno",
    "code",
    "codigo",
    "statusCode",
    "acquirerCode",
    "issuerCode"
  ];
  const msgKeys = [
    "returnMessage",
    "errorMessage",
    "mensagem",
    "message",
    "description",
    "descricao",
    "reason",
    "motivo",
    "detail",
    "error_description"
  ];
  const nsuKeys = [
    "nsu",
    "NSU",
    "tid",
    "TID",
    "authorizationCode",
    "authorisationCode",
    "authorization_code",
    "authCode"
  ];

  const walk = (obj, keys) => {
    if (!obj || typeof obj !== "object") return null;
    for (const k of keys) {
      if (obj[k] != null && String(obj[k]).trim()) return String(obj[k]).trim();
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") {
        const hit = walk(v, keys);
        if (hit) return hit;
      }
    }
    return null;
  };

  const code = walk(body, codeKeys);
  const message = walk(body, msgKeys);
  const nsu = walk(body, nsuKeys);
  return { code, message, nsu };
};

const scoreGatePayload = (url, body, httpStatus) => {
  let score = 0;
  const u = String(url || "");
  if (GATE_SKIP_URL_RE.test(u)) return 0;
  if (GATE_TELEMETRY_URL_RE.test(u)) return 0;
  if (
    !/claro\.com\.br|clarorecarga|minhaclaro|m4u\.com\.br|plat-m4u|api\./i.test(u) &&
    !GATE_URL_RE.test(u)
  ) {
    return 0;
  }
  // HTML de challenge/Cardinal não é resposta da gate.
  if (typeof body === "object" && body && body._raw && /<!DOCTYPE|<html/i.test(String(body._raw))) {
    return 0;
  }
  const earlyFields = pickGateFields(body);
  const blobPreview = (() => {
    try {
      return JSON.stringify(body || "").slice(0, 200);
    } catch {
      return "";
    }
  })();
  if (/<!DOCTYPE|<html[\s>]/i.test(blobPreview) && !earlyFields.code && !earlyFields.message) {
    return 0;
  }

  if (/m4u\.com\.br|claro-recarga-api/i.test(u)) score += 8;
  if (GATE_URL_RE.test(u)) score += 4;
  if (/pagamento|payment|authorize|charge|checkout|transac|\/recharges/i.test(u)) score += 6;
  if (/\/loop\/events/i.test(u) && /DENIED|checkout:received/i.test(JSON.stringify(body || ""))) score += 14;

  const fields = pickGateFields(body);
  if (fields.code) score += 8;
  if (fields.message) score += 5;
  if (fields.nsu) score += 4;
  if (Array.isArray(body) && body[0]?.status === "ok" && body[0]?.paymentMethod?.nsu) {
    if (/\/recharges\/result/i.test(u)) score += 10;
    else if (!/\/recharges\b/i.test(u)) score += 10;
  }
  if (Array.isArray(body) && body[0]?.status === "nok") score += 6;
  if (/^CONFIRMED$/i.test(String(body?.status || "")) || body?.payments?.[0]?.status === "CONFIRMED") score += 12;

  const blob = JSON.stringify(body || {}).slice(0, 8000);
  if (GATE_BODY_KEYS_RE.test(blob)) score += 3;
  if (/recus|declin|negad|insufficient|nao\s*autoriz|não\s*autoriz|erro.*pagamento|payment.*fail/i.test(blob)) {
    score += 6;
  }
  if (/sucesso|approved|aprovad|authorized|autorizado/i.test(blob) && /payment|pagamento|transac/i.test(u + blob)) {
    score += 3;
  }
  if (httpStatus >= 400) score += 2;
  return score;
};

const sanitizeGateBody = (body, maxLen = 12000) => {
  try {
    const raw = JSON.stringify(body);
    if (raw.length <= maxLen) return body;
    return { _truncated: true, preview: raw.slice(0, maxLen) };
  } catch {
    return { _unserializable: true };
  }
};

const summarizeGateCapture = (capture) => {
  if (!capture?.body) {
    return { code: null, message: null, nsu: null, summary: "" };
  }
  const fields = pickGateFields(capture.body);
  const parts = [];
  if (fields.nsu) parts.push(`nsu=${fields.nsu}`);
  if (fields.code && !/^ok$/i.test(String(fields.code))) parts.push(`code=${fields.code}`);
  if (fields.message) parts.push(fields.message);
  if (!parts.length) {
    const strings = [];
    deepFindStrings(capture.body, strings);
    const interesting = strings.find((s) =>
      /erro|recus|declin|negad|autoriz|fail|invalid|insufficient|sucesso|aprov/i.test(s)
    );
    if (interesting) parts.push(interesting.slice(0, 240));
  }
  return {
    code: fields.code || null,
    message: fields.message || null,
    nsu: fields.nsu || null,
    summary: parts.join(" | ").slice(0, 500)
  };
};

/** Só imprime gate no console quando há sinal útil (sucesso/erro de pagamento). */
const shouldLogGateCapture = (url, httpStatus, sum) => {
  const u = String(url || "");
  if (GATE_TELEMETRY_URL_RE.test(u)) return false;
  if (httpStatus >= 400) return true;
  if (/\/recharges\b/i.test(u)) return true;
  if (/\/pagamento|\/payment|authorize|charge|checkout|braspag/i.test(u)) return true;
  const msg = `${sum.message || ""} ${sum.summary || ""}`;
  if (/recus|declin|negad|fail|invalid|insufficient|block|negative|interval|unlocked|lista|erro|denied|forbidden/i.test(msg)) {
    return true;
  }
  if (sum.nsu && /\/recharges|payment|pagamento|authorize/i.test(u)) return true;
  if (sum.code && !/^ok$/i.test(String(sum.code))) return true;
  return false;
};

const attachGateCapture = (context, session = null) => {
  const captures = [];
  const onResponse = async (response) => {
    try {
      const url = response.url();
      if (GATE_SKIP_URL_RE.test(url)) return;
      if (GATE_TELEMETRY_URL_RE.test(url)) return;
      const httpStatus = response.status();
      // Doc §7 / §13: POST smartcheckout/v2/url → 201 (URL Eldorado + token)
      if (session && /smartcheckout\/v2\/url/i.test(url)) {
        if (httpStatus === 429) {
          session.checkoutApiError = { httpStatus: 429, code: "rate_limit", url, at: Date.now() };
        } else if (httpStatus >= 400) {
          session.checkoutApiError = { httpStatus, code: "checkout_api_error", url, at: Date.now() };
        } else if (httpStatus === 201) {
          session.checkoutApiOk = true;
          session.checkoutApiOkAt = Date.now();
        }
      }
      // Doc §13 passo 2: GET bemobi /api/v1/session → 201
      if (session && /smart-checkout\.bemobi\.com\/api\/v1\/session/i.test(url) && httpStatus === 201) {
        session.bemobiSessionOk = true;
        session.bemobiSessionOkAt = Date.now();
      }
      const ct = String(response.headers()["content-type"] || "");
      const looksJson = /json|text\/plain|javascript/i.test(ct) || /\/api\/|graphql|\.json/i.test(url);
      if (!looksJson && !GATE_URL_RE.test(url)) return;

      let body = null;
      try {
        body = await response.json();
      } catch {
        try {
          const text = await response.text();
          if (!text || text.length > 200000) return;
          const trimmed = text.trim();
          if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            body = JSON.parse(trimmed);
          } else if (trimmed.startsWith("data:")) {
            body = parseSseJson(trimmed) || { _raw: trimmed.slice(0, 4000) };
          } else if (GATE_URL_RE.test(url) && trimmed.length < 4000) {
            body = { _raw: trimmed.slice(0, 2000) };
          }
        } catch {
          return;
        }
      }
      if (body == null) return;

      if (session && /smartcheckout\/v2\/url/i.test(url) && httpStatus === 201 && body?.url) {
        session.checkoutEldoradoUrl = String(body.url);
      }

      let score = scoreGatePayload(url, body, response.status());
      if (
        score < 4 &&
        /eldorado\.m4u|claro-recarga-api|\/recharges\b|\/loop\/events|\/api\/v1\/payments|wallet|card/i.test(url)
      ) {
        score = 4;
      }
      if (score < 4) return;

      let requestBody = null;
      if (isGateRequestCaptureUrl(url)) {
        try {
          requestBody = response.request().postDataJSON?.();
          if (!requestBody) {
            const raw = response.request().postData();
            if (raw) requestBody = JSON.parse(raw);
          }
          if (requestBody) requestBody = sanitizeGateBody(requestBody, 8000);
        } catch {
          // ignore
        }
      }

      captures.push({
        ts: Date.now(),
        url,
        method: response.request().method(),
        httpStatus: response.status(),
        score,
        body: sanitizeGateBody(body, 8000),
        ...(requestBody ? { requestBody } : {})
      });
      if (captures.length > 40) captures.splice(0, captures.length - 40);

      const sum = summarizeGateCapture(captures[captures.length - 1]);
      if (shouldLogGateCapture(url, response.status(), sum)) {
        if (sum.summary) {
          console.log(`[claro][gate] score=${score} http=${response.status()} ${sum.summary}`);
        } else {
          console.log(`[claro][gate] score=${score} http=${response.status()} url=${url.slice(0, 160)}`);
        }
      }
    } catch {
      // ignore parse/race
    }
  };

  context.on("response", onResponse);
  return {
    captures,
    detach: () => {
      try {
        context.off("response", onResponse);
      } catch {
        // ignore
      }
    },
    best: () => {
      if (!captures.length) return null;
      const rank = (c) => {
        let r = c.score;
        const u = String(c.url || "");
        const m = String(c.method || "GET").toUpperCase();
        const b = c.body;
        if (m === "POST" || m === "PUT" || m === "PATCH") r += 18;
        if (c.httpStatus >= 400) r += 14;
        if (Array.isArray(b) && /\/recharges\b/i.test(u) && !/\/recharges\/result/i.test(u)) r -= 50;
        if (Array.isArray(b) && /\/recharges\/result/i.test(u) && b[0]?.status === "ok" && b[0]?.paymentMethod?.nsu) {
          r += 22;
        }
        if (Array.isArray(b) && b[0]?.status === "nok") r += 10;
        if (Array.isArray(b) && /\/recharges\b/i.test(u) && b[0]?.status === "nok") r -= 12;
        if (/\/loop\/events/i.test(u) && b?.tags?.transaction?.status === "DENIED") r += 28;
        if (/\/payments/i.test(u) && (b?.status === "DENIED" || b?.payments?.[0]?.status === "DENIED")) r += 32;
        if (/\/payments\/.+\/sse/i.test(u)) r += 20;
        if (/\/payments/i.test(u) && (b?.status === "CONFIRMED" || b?.payments?.[0]?.status === "CONFIRMED")) r += 40;
        if (/\/payments/i.test(u) && /^PENDING$/i.test(String(b?.status || ""))) r -= 24;
        if (/src\.mastercard\.com|auth\.visa\.com|cardinalcommerce\.com/i.test(u)) r -= 80;
        if (b?.data?.errors || b?.errors) r += 16;
        if (b?.exception) r += 10;
        if (typeof b?.status === "string" && /^nok$/i.test(b.status)) r += 8;
        return r * 1e6 + c.ts;
      };
      return [...captures].sort((a, b) => rank(b) - rank(a))[0];
    }
  };
};

const attachClaroNetworkHooks = (context, session = null) => {
  const gateCapture = attachGateCapture(context, session);
  if (session) {
    session.gateCapture = gateCapture;
  }
  return { gateCapture };
};

const M4U_API_RE = /claro-recarga-api\.m4u\.com\.br/i;

/** Observa POST /sessions/ e GET /customers/ (landing WhatsApp — doc M4U). */
const attachM4uAuthCapture = (context) => {
  let lastSessions = null;
  let lastSmsToken = null;
  let lastCustomer = null;

  const onResponse = async (response) => {
    try {
      const url = response.url();
      if (!M4U_API_RE.test(url)) return;
      const method = response.request().method();
      const status = response.status();
      const ts = Date.now();

      if (method === "POST" && /\/sms-tokens\/?(\?|$)/i.test(url)) {
        lastSmsToken = { status, ts };
        console.log(`[claro][m4u] POST /sms-tokens/ → ${status}`);
        return;
      }

      if (method === "POST" && /\/sessions\/?(\?|$)/i.test(url)) {
        const entry = { status, ts, url };
        try {
          if (status === 200) {
            entry.bodyJson = await response.json();
          } else {
            entry.bodyText = String(await response.text()).slice(0, 500);
          }
        } catch {
          // body já consumido
        }
        if (lastSessions?.status === 200 && lastSessions.bodyJson?.id && status !== 200) {
          console.log(`[claro][m4u] POST /sessions/ → ${status} (mantém login 200 anterior)`);
          return;
        }
        lastSessions = entry;
        console.log(`[claro][m4u] POST /sessions/ → ${status}`);
        return;
      }

      if (method === "GET" && /\/customers\//i.test(url)) {
        const entry = { status, ts, url };
        try {
          if (status === 200) entry.bodyJson = await response.json();
          else entry.bodyText = String(await response.text()).slice(0, 800);
        } catch {
          // ignore
        }
        lastCustomer = entry;
      }
    } catch {
      // ignore
    }
  };

  context.on("response", onResponse);
  return {
    lastSessions: () => lastSessions,
    lastSmsToken: () => lastSmsToken,
    lastCustomer: () => lastCustomer,
    waitForSessionsResult: async (timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (lastSessions && Date.now() - lastSessions.ts <= 45000) return lastSessions;
        await sleep(200);
      }
      return lastSessions;
    },
    waitForCustomerResult: async (timeoutMs = 12000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (lastCustomer && Date.now() - lastCustomer.ts <= 90000) return lastCustomer;
        await sleep(200);
      }
      return lastCustomer;
    },
    detach: () => {
      try {
        context.off("response", onResponse);
      } catch {
        // ignore
      }
    }
  };
};

const claroFlowError = (code, message) => {
  const err = new Error(message);
  err.claroErrorCode = code;
  return err;
};

const classifyClaroFlowError = (errText, session) => {
  const t = String(errText || "");
  const m4u = session?.m4uAuthCapture?.lastSessions?.();
  const smsWasOk = postSmsAuthOk(session) || m4u?.status === 200;

  if (
    /cadastrar novo cart[aã]o.*desabilitad|cadastrar novo cart[aã]o.*indispon|novo_cartao_desabilitado|cadastro.*exclu/i.test(
      t
    )
  ) {
    return {
      code: "cadastro_deletado",
      message:
        "Cadastro Claro Recarga excluído ou indisponível — não é possível cadastrar cartão nesta linha. Peça ao cliente refazer o cadastro em clarorecarga.claro.com.br."
    };
  }
  if (!smsWasOk && m4u?.status === 400) {
    return { code: "sms_invalid", message: "Código SMS incorreto ou expirado (Claro: Bad Request)." };
  }
  if (
    !smsWasOk &&
    /c[oó]digo SMS|Bad Request|inv[aá]lid|incorret|expir|c[oó]digo SMS rejeitado/i.test(t) &&
    /voltou para a tela|número vazio|400 Bad Request/i.test(t)
  ) {
    return {
      code: "sms_invalid",
      message: "Código SMS incorreto ou expirado. Inicie nova recarga e envie só os dígitos do SMS."
    };
  }
  const cust = session?.m4uAuthCapture?.lastCustomer?.();
  if (cust && (cust.status === 404 || cust.status === 410)) {
    return {
      code: "cadastro_deletado",
      message: "Cliente não encontrado na Claro Recarga (cadastro excluído ou inexistente)."
    };
  }
  if (smsWasOk && /c[oó]digo SMS inv[aá]lid|voltou para a tela inicial/i.test(t)) {
    return {
      code: "erro_fluxo",
      message:
        "SMS já tinha sido aceito; a falha foi depois (tela/cartão), não código SMS errado. Tente nova recarga."
    };
  }
  if (/valor_indisponivel|n[aã]o dispon[ií]vel na [Cc]laro|Opções:/i.test(t)) {
    return { code: "valor_indisponivel", message: t || "Valor não disponível na Claro." };
  }
  if (
    session?.gateCapture &&
    gateCapturePixOnly(session.gateCapture) &&
    !gateCaptureHasCredit(session.gateCapture) &&
    /sem campo PAN|formul[aá]rio de cart[aã]o|checkout n[aã]o abriu|#pan/i.test(t)
  ) {
    return {
      code: "valor_indisponivel",
      message: "Valor não disponível nesse número (cartão indisponível nesta linha)."
    };
  }
  return { code: "erro_fluxo", message: t || "Erro no fluxo Claro." };
};

const negativeListBlob = (paymentResult) =>
  [
    paymentResult?.gateCode,
    paymentResult?.gateMessage,
    paymentResult?.message,
    JSON.stringify(paymentResult?.gateResponse?.body || "")
  ]
    .filter(Boolean)
    .join(" ");

/** recipient / customermsisdn / qualquer negative_list_* da gate Claro */
const isNegativeListGate = (paymentResult) =>
  /negative_list_/i.test(negativeListBlob(paymentResult));

const negativeListKind = (paymentResult) => {
  const blob = negativeListBlob(paymentResult);
  if (/negative_list_recipient/i.test(blob)) return "recipient";
  if (/negative_list_customermsisdn/i.test(blob)) return "customermsisdn";
  return "other";
};

/** SNARF0043 (3 cartões na conta) / SNARF0036 (cartão em 3 números) — retry não adianta. */
const isFatalCardGateFailure = (paymentResult) => {
  if (!paymentResult || paymentResult.status !== "error") return false;
  return /SNARF0043|SNARF0036|maximum.*card|max.*3.*card|3.*n[uú]meros?/i.test(gateBlob(paymentResult));
};

/** Gate que vale trocar cartão (sem novo SMS): LI1028 genérica ou LI1027 sem fundos. */
const isGenericGateFailure = (paymentResult) => {
  if (!paymentResult || paymentResult.status !== "error") return false;
  if (isFatalCardGateFailure(paymentResult)) return false;
  const blob = gateBlob(paymentResult);
  return /LI1028|generic reason|authorization failed due to generic|LI1027|insufficient funds|sem fundos|saldo insuficiente/i.test(
    blob
  );
};

const gateRetryLabel = (paymentResult) => {
  const blob = [
    paymentResult?.gateCode,
    paymentResult?.gateMessage,
    paymentResult?.message
  ]
    .filter(Boolean)
    .join(" ");
  if (/LI1027|insufficient funds|sem fundos|saldo insuficiente/i.test(blob)) {
    return "sem fundos (LI1027)";
  }
  return "genérica (LI1028)";
};

const resetPamForNextCardAttempt = (session, payload) => {
  session.pamTouchCommitted = false;
  session.claimedPam = null;
  if (payload) payload.pamInfo = "";
};

const recordIntermediatePamFailure = (session, payload, paymentResult) => {
  try {
    finalizePamLedger(session, payload, paymentResult, null);
  } catch (err) {
    console.warn(`[claro][pam] ledger retry: ${err?.message || err}`);
  }
  resetPamForNextCardAttempt(session, payload);
};

const clearGateCaptures = (session) => {
  const caps = session?.gateCapture?.captures;
  if (Array.isArray(caps)) caps.length = 0;
};

/** LI1028 / LI1027 (sem fundos) → novo cartão do info.txt (sem SMS), até genericGateRetries vezes. Gate 54 → login novo (bot). */
const runCardAndPayWithGenericRetry = async (session, payload) => {
  if (isWebPortalSession(session)) {
    return runWebLinkRechargeWithRetry(session, payload);
  }
  const maxExtra = Math.max(0, config.genericGateRetries ?? 2);
  let paymentResult = await runCardAndPay(session, payload);
  let extra = 0;
  while (isGenericGateFailure(paymentResult) && extra < maxExtra) {
    extra += 1;
    const why = gateRetryLabel(paymentResult);
    setSessionStep(
      session,
      "retry_troca_cartao",
      `Gate ${why} — retry ${extra}/${maxExtra} com novo cartão…`
    );
    console.log(`[claro] ${why} — retry ${extra}/${maxExtra} session=${session.id}`);
    recordIntermediatePamFailure(session, payload, paymentResult);
    clearGateCaptures(session);
    await sleep(1500);
    await ensureAuthenticatedHome(session);
    session.useExistingSavedCard = false;
    paymentResult = await runCardAndPay(session, payload);
  }
  return paymentResult;
};

const classifyFailedClaroPayment = (runError, paymentResult, session, lastErrorText) => {
  if (paymentResult?.status === "3ds_blocked" || paymentResult?.gateCode === "3DS_BLOCKED") {
    return {
      code: "3ds_blocked",
      message: paymentResult?.message || "3DS exigido pelo banco — recarga abortada"
    };
  }
  const gatePixOnly =
    session?.gateCapture &&
    gateCapturePixOnly(session.gateCapture) &&
    !gateCaptureHasCredit(session.gateCapture);
  if (gatePixOnly) {
    return {
      code: "valor_indisponivel",
      message: "Valor não disponível nesse número (cartão indisponível nesta linha)."
    };
  }
  if (runError?.claroErrorCode) {
    return { code: runError.claroErrorCode, message: String(runError.message || runError) };
  }
  if (isNegativeListGate(paymentResult)) {
    const kind = negativeListKind(paymentResult);
    return {
      code: "lista_negativa_claro",
      message:
        kind === "recipient"
          ? "Número destino na lista negativa da Claro (negative_list_recipient) — cadastro excluído; não adianta tentar de novo nesta linha."
          : "Linha bloqueada na Claro Recarga (lista negativa). Cadastro excluído; número bloqueado no bot por 30 dias."
    };
  }
  const blob = gateBlob(paymentResult);
  if (/SNARF0043/i.test(blob)) {
    return {
      code: "cartao_limite_conta",
      message:
        "Conta Claro já tem 3 cartões cadastrados (SNARF0043). Limpe pelo app Meu Claro — o portal nlog não lista todos."
    };
  }
  if (/SNARF0036/i.test(blob)) {
    return {
      code: "cartao_limite_vinculo",
      message: "Este cartão já está vinculado a 3 números (SNARF0036). Use outro cartão."
    };
  }
  if (/LI1037|Invalid msisdn|invalid msisdn/i.test(blob)) {
    return { code: "numero_invalido_claro", message: "Número inválido para recarga na Claro." };
  }
  if (/LI1027|insufficient funds|sem fundos|saldo insuficiente|CREDIT_CARD\s*-\s*51\b/i.test(blob)) {
    return { code: "cartao_sem_fundos", message: "Cartão sem saldo." };
  }
  if (/CREDIT_CARD\s*-\s*54\b|code=54\b|DATA DE EXPIRA/i.test(blob)) {
    return { code: "gate_54", message: "Cartão recusado — validade inválida (gate 54)." };
  }
  return classifyClaroFlowError(lastErrorText, session);
};

/** SMS ok mas a Claro devolve landing ao abrir cartão = cadastro excluído nesta linha. */
const throwCadastroDeletadoAfterSms = async (page, session, { debugStep } = {}) => {
  if (debugStep) await saveStepDebug(page, debugStep);
  const card = await inspectNewCardOption(page);
  if (card.found && !card.enabled) {
    markAuthLost(session);
    throw claroFlowError(
      "cadastro_deletado",
      'Opção "Cadastrar novo cartão" desabilitada — cadastro Claro Recarga excluído ou indisponível nesta linha.'
    );
  }
  markAuthLost(session);
  throw claroFlowError(
    "cadastro_deletado",
    "Cadastro Claro Recarga excluído ou indisponível nesta linha (SMS válido, sem área de cartão)."
  );
};

const isPostSmsLandingUrl = (page) => {
  const u = page.url() || "";
  return /\/whatsapp\/landing/i.test(u) || /\/minhaclaro_app_nlog\/landing/i.test(u);
};

const guardLandingInCardFlow = async (page, session, { debugStep } = {}) => {
  if (postSmsAuthOk(session)) {
    const visualLanding = await isVisualLandingLogin(page);
    // ponytail: pós-SMS a Claro pode voltar ao /landing com número ainda preenchido — não exige campo vazio.
    if (visualLanding || isPostSmsLandingUrl(page)) {
      await throwCadastroDeletadoAfterSms(page, session, { debugStep });
    }
    return;
  }
  if (await isBackOnLandingLogin(page, session)) {
    await throwAuthFailure(page, session, { debugStep });
  }
};

const throwAuthFailure = async (page, session, { debugStep } = {}) => {
  if (debugStep) await saveStepDebug(page, debugStep);
  const smsWasOk = postSmsAuthOk(session);

  if (smsWasOk) {
    const card = await inspectNewCardOption(page);
    if (card.found && !card.enabled) {
      markAuthLost(session);
      throw claroFlowError(
        "cadastro_deletado",
        'Opção "Cadastrar novo cartão" desabilitada — cadastro Claro Recarga excluído ou indisponível nesta linha.'
      );
    }
    try {
      const snippet = await page.evaluate(
        () => (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 2500)
      );
      if (/cadastrar novo cart[aã]o.*indispon|cadastro.*exclu[ií]do|sem permiss[aã]o/i.test(snippet)) {
        markAuthLost(session);
        throw claroFlowError(
          "cadastro_deletado",
          "Cadastro Claro Recarga excluído ou indisponível nesta linha."
        );
      }
    } catch (e) {
      if (e?.claroErrorCode === "cadastro_deletado") throw e;
    }
    markAuthLost(session);
    throw claroFlowError(
      "erro_fluxo",
      "SMS aceito pela Claro, mas não foi possível abrir cartão/recarga (tela inconsistente). Não é SMS errado — tente de novo."
    );
  }

  const m4u = session?.m4uAuthCapture?.lastSessions?.();
  if (m4u?.status === 400) {
    markAuthLost(session);
    throw claroFlowError(
      "sms_invalid",
      "Código SMS incorreto ou expirado (API Claro: 400 Bad Request)."
    );
  }
  if (await isBackOnLandingLogin(page, session)) {
    markAuthLost(session);
    throw claroFlowError(
      "sms_invalid",
      "Código SMS inválido ou sessão expirada — voltou para a tela inicial."
    );
  }
  markAuthLost(session);
  throw claroFlowError("erro_fluxo", "Não foi possível continuar após o SMS.");
};

const persistGateDebug = async (capture, paymentStatus, gateCapture = null) => {
  const all = Array.isArray(gateCapture?.captures) ? gateCapture.captures : capture ? [capture] : [];
  if (!capture && !all.length) return;
  try {
    await fs.mkdir(CLARO_DEBUG_DIR, { recursive: true });
    const ts = Date.now();
    const bestFile = path.join(CLARO_DEBUG_DIR, `gate_${ts}_${paymentStatus || "na"}.json`);
    await fs.writeFile(bestFile, JSON.stringify(capture || all[all.length - 1], null, 2), "utf8");
    await fs.writeFile(
      path.join(CLARO_DEBUG_DIR, `gate_all_${ts}_${paymentStatus || "na"}.json`),
      JSON.stringify(
        all.map((c) => ({
          ts: c.ts,
          url: c.url,
          method: c.method,
          httpStatus: c.httpStatus,
          score: c.score,
          body: c.body
        })),
        null,
        2
      ),
      "utf8"
    );
    console.log(`[claro][gate] Artefato salvo: ${bestFile} (+${all.length} reqs)`);
  } catch (err) {
    console.warn(`[claro][gate] falha ao salvar debug: ${err?.message || err}`);
  }
};

export const normalizeBrowserName = (raw) => {
  const n = String(raw ?? "chromium")
    .trim()
    .toLowerCase();
  if (n === "chrome" || n === "google chrome") return "chrome";
  if (n === "edge" || n === "msedge" || n === "microsoft edge") return "edge";
  if (n === "firefox" || n === "mozilla firefox") return "firefox";
  if (VALID_BROWSERS.has(n)) return n;
  return "chromium";
};

/** Se BROWSER_NAME/DEFAULT_BROWSER existir no CLARO/.env, prevalece sobre o payload da UI. */
export const resolveBrowserName = (payload) => {
  const rawEnv = String(process.env.BROWSER_NAME || process.env.DEFAULT_BROWSER || "").trim();
  if (rawEnv) {
    return normalizeBrowserName(rawEnv);
  }
  return normalizeBrowserName(
    payload?.browser ?? payload?.browserName ?? config.defaultBrowser
  );
};

export const isBrowserLockedByEnv = () =>
  Boolean(String(process.env.BROWSER_NAME || process.env.DEFAULT_BROWSER || "").trim());

export const launchBrowser = async (browserName) => {
  const name = normalizeBrowserName(browserName);
  // Ambient HEADLESS=true (Cursor/sandbox) não pode esconder a janela operacional.
  const headless = config.headless === true;
  const launchOpts = {
    headless,
    args: [
      `--window-size=${config.browserWindowWidth},${config.browserWindowHeight}`,
      "--window-position=80,40"
    ]
  };
  console.log(`[claro] launch browser=${name} headless=${headless}`);

  if (name === "chrome") {
    return chromium.launch({ ...launchOpts, channel: "chrome" });
  }
  if (name === "edge") {
    return chromium.launch({ ...launchOpts, channel: "msedge" });
  }
  if (name === "firefox") {
    return firefox.launch({ headless });
  }
  return chromium.launch(launchOpts);
};

const randomName = (maxLen = 7) => {
  const names = [
    "Ana Silva",
    "Joao Lima",
    "Caio Reis",
    "Lia Costa",
    "Maya Souza",
    "Nina Melo",
    "Ivo Prado"
  ];
  const selected = names[Math.floor(Math.random() * names.length)];
  return selected.slice(0, maxLen);
};

const normalizeBrMobile = (raw) => {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) {
    digits = `${digits.slice(0, 2)}9${digits.slice(2)}`;
  }
  return digits;
};

const splitPamInfo = (pamInfo) => {
  const rawLine = String(pamInfo ?? "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((v) => v.trim())
    .find((v) => v.length > 0);

  const normalized = normalizePamLine(rawLine);
  if (!normalized) {
    throw new Error("PAM inválido. Use formato: PAN|MES|ANO");
  }

  const parts = normalized.split("|");
  const pan = String(parts[0] ?? "").replace(/\D/g, "");
  const month = String(parts[1] ?? "").trim();
  const year = String(parts[2] ?? "").trim();
  const cvv = parts[3] ? String(parts[3]).replace(/\D/g, "") : "";

  if (!pan || pan.length < 13 || !month || !year) {
    throw new Error("PAM inválido. Use formato: PAN|MES|ANO");
  }

  const mm = month.padStart(2, "0");
  const yy = year.length > 2 ? year.slice(-2) : year.padStart(2, "0");
  return {
    pan,
    mm,
    yy,
    mmYY: `${mm}/${yy}`,
    cvv: cvv || null
  };
};

const CARD_PAN_SELECTORS = [
  "#pan",
  'input[data-cy="pan"]',
  'input[autocomplete="cc-number"]',
  'input[name="pan"]'
];
const CARD_EXP_SELECTORS = [
  "#expiration",
  'input[name="expirationDate"]',
  'input[data-cy="expiration"]',
  'input[autocomplete="cc-exp"]'
];
const CARD_CVV_SELECTORS = [
  "#cvv",
  'input[name="cvv"]',
  'input[data-cy="cvv"]',
  'input[autocomplete="cc-csc"]'
];
const CARD_HOLDER_SELECTORS = [
  "#holder",
  'input[name="holder"]',
  'input[data-cy="holder"]',
  'input[autocomplete="cc-name"]'
];

const isEldoradoCheckoutUrl = (url) => /eldorado\.m4u\.com\.br\/bsc\/checkout/i.test(url || "");

/** Procura em todos os frames (checkout Eldorado → new-claro-recarga aninhado). */
const findCardFormContext = async (page) => {
  for (const frame of page.frames()) {
    const eldorado = isEldoradoCheckoutUrl(frame.url());
    for (const sel of CARD_PAN_SELECTORS) {
      try {
        const pan = frame.locator(sel).first();
        if ((await pan.count()) === 0) continue;
        await pan.waitFor({ state: eldorado ? "attached" : "visible", timeout: eldorado ? 2500 : 800 });
        if (await pan.isDisabled().catch(() => false)) continue;
        return frame;
      } catch {
        // frame ainda montando
      }
    }
  }
  return null;
};

/** Eldorado BSC: Novo crédito → Cartão Crédito → campos name=pan. */
const prepareEldoradoCheckoutForm = async (page) => {
  for (const frame of page.frames()) {
    if (!isEldoradoCheckoutUrl(frame.url())) continue;
    try {
      const bodyText = await frame.evaluate(() => document.body?.innerText || "");
      if (/Escolha como pagar/i.test(bodyText)) {
        const credito = frame.getByText(/Cart[aã]o\s+Cr[eé]dito/i).first();
        if ((await credito.count()) > 0) {
          await credito.click({ timeout: 3000 }).catch(() => {});
          await sleep(900);
        }
      }
      for (const label of [
        "Novo crédito",
        "Novo credito",
        "Número do cartão",
        "Número do cartao"
      ]) {
        const loc = frame.getByText(new RegExp(label, "i")).first();
        if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
          await loc.click({ timeout: 2500 });
          console.log(`[claro] eldorado: clicou "${label}"`);
          await sleep(700);
          break;
        }
      }
    } catch {
      // ignore
    }
  }
};

/** Eldorado BSC demora após iframe#checkout montar — aguarda texto/campos reais. */
const waitForEldoradoCheckoutReady = async (page, timeoutMs = 45000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!isEldoradoCheckoutUrl(frame.url())) continue;
      try {
        const ready = await frameEvalWithTimeout(
          frame,
          () => {
            const t = document.body?.innerText || "";
            if (/Escolha como pagar|N[uú]mero do cart/i.test(t)) return true;
            const pan = document.querySelector('input[name="pan"]');
            return pan instanceof HTMLInputElement;
          },
          2500
        );
        if (ready) return frame;
      } catch {
        // frame ainda montando
      }
    }
    await dismissCookieBanner(page).catch(() => {});
    await sleep(400);
  }
  return null;
};

const fillEldoradoField = async (frame, selector, value, { type = false } = {}) => {
  const input = frame.locator(selector).first();
  if ((await input.count()) === 0) return false;
  try {
    await input.waitFor({ state: "attached", timeout: 2000 });
  } catch {
    return false;
  }
  await input.click({ force: true, timeout: 1500 }).catch(() => {});
  const v = String(value);
  await input.fill(v, { force: true }).catch(() => {});
  let got = await input.inputValue().catch(() => "");
  const digits = got.replace(/\D/g, "");
  const wantDigits = v.replace(/\D/g, "");
  if (!got || (wantDigits && digits.length < Math.max(1, wantDigits.length - 2))) {
    await frame.evaluate(
      ({ sel, val }) => {
        const el = document.querySelector(sel);
        if (!(el instanceof HTMLInputElement)) return;
        el.focus();
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { sel: selector, val: v }
    );
  }
  return true;
};

const normalizeCardExpiry = (raw) => {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^\d{2}\/\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/|]?(\d{2,4})$/);
  if (!m) return null;
  const mm = m[1].padStart(2, "0");
  const yy = m[2].length > 2 ? m[2].slice(-2) : m[2].padStart(2, "0");
  return `${mm}/${yy}`;
};

/** Inspect: troca validade no iframe Eldorado logo antes de Pagar (teste de erro gate). */
const patchEldoradoExpiryBeforePay = async (page, mmYY) => {
  const exp = normalizeCardExpiry(mmYY);
  if (!exp) return false;
  let frame = await waitForEldoradoCheckoutReady(page, 5000);
  if (!frame) {
    for (const f of page.frames()) {
      if (isEldoradoCheckoutUrl(f.url())) {
        frame = f;
        break;
      }
    }
  }
  if (!frame) return false;
  const ok = await fillEldoradoField(frame, 'input[name="expirationDate"]', exp, { type: true });
  console.log(`[claro] INSPECT expiry override -> ${exp} ok=${ok}`);
  return ok;
};

const eldoradoHasPan = async (frame) => {
  try {
    const pan = frame.locator('input[name="pan"]').first();
    return (await pan.count()) > 0;
  } catch {
    return false;
  }
};

/** Cartão salvo mostra só CVV — clica Novo crédito e espera input[name=pan] montar. */
const waitForEldoradoPanField = async (page, session, timeoutMs = 35000) => {
  const deadline = Date.now() + timeoutMs;
  let lastKick = 0;
  while (Date.now() < deadline) {
    for (const frame of eldoradoCheckoutFrames(page)) {
      if (await eldoradoHasPan(frame)) return frame;
    }
    if (Date.now() - lastKick > 1800) {
      lastKick = Date.now();
      if (session) setSessionStep(session, "fill_pan", "Aguardando campo PAN no checkout…");
      await prepareEldoradoCheckoutForm(page);
      if (await hasSavedCardInCheckout(page)) {
        await removeSavedCardsInCheckout(page).catch(() => {});
      }
      await clickCheckoutNewCard(page);
    }
    await sleep(450);
  }
  return null;
};

/** Smart Checkout Eldorado: só preenche input que existe. Sem wait de 12s. */
const fillEldoradoBscCheckout = async (page, pam, session) => {
  setSessionStep(session, "fill_eldorado", "Preenchendo checkout Eldorado…");
  await dismissCookieBanner(page);

  let frame = await waitForEldoradoCheckoutReady(page);
  if (!frame) throw new Error("Checkout Eldorado não carregou (iframe vazio).");

  frame = (await waitForEldoradoPanField(page, session, 35000)) || frame;
  if (!(await eldoradoHasPan(frame))) {
    if (await detectPixOnlyCheckout(page, session)) {
      throw claroFlowError(
        "valor_indisponivel",
        "Valor não disponível nesse número (cartão indisponível nesta linha)."
      );
    }
    throw new Error("Formulário de cartão novo não abriu (sem campo PAN).");
  }

  const pan = String(pam.pan).replace(/\D/g, "");
  const exp = String(pam.mmYY);
  const cvv = String(pam.cvv || config.defaultCvv);
  const holder = String(randomName(config.defaultCardholderMaxLen));

  console.log("[claro] Eldorado BSC: preenchendo só campos visíveis…");
  const panOk = await fillEldoradoField(frame, 'input[name="pan"]', pan);
  await fillEldoradoField(frame, 'input[name="expirationDate"]', exp, { type: true });
  await fillEldoradoField(frame, 'input[name="cvv"]', cvv);
  await fillEldoradoField(frame, 'input[name="holder"]', holder, { type: true });

  const panVal = await frame.locator('input[name="pan"]').first().inputValue().catch(() => "");
  if (!panOk || !panVal || panVal.replace(/\D/g, "").length < 13) {
    throw new Error(`PAN não preenchido no Eldorado (valor="${(panVal || "").slice(0, 6)}").`);
  }
};

const clickEldoradoPayButton = async (page, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!isEldoradoCheckoutUrl(frame.url())) continue;
      try {
        for (const loc of [
          frame.getByRole("button", { name: /Pagar\s+R\$/i }),
          frame.getByText(/Pagar\s+R\$/i)
        ]) {
          const btn = loc.first();
          if ((await btn.count()) === 0) continue;
          if (!(await btn.isVisible().catch(() => false))) continue;
          if (!(await btn.isEnabled().catch(() => true))) continue;
          await btn.click({ timeout: 5000 });
          return true;
        }
      } catch {
        // tenta próximo frame
      }
    }
    await sleep(350);
  }
  return false;
};

const firstLocator = (ctx, selectors) => {
  for (const sel of selectors) {
    const loc = ctx.locator(sel).first();
    if (loc) return loc;
  }
  return ctx.locator(selectors[0]).first();
};

/** Primeiro seletor que realmente existe no frame (Eldorado não tem #pan). */
const resolveLocator = async (ctx, selectors) => {
  for (const sel of selectors) {
    const loc = ctx.locator(sel).first();
    if ((await loc.count()) > 0) return loc;
  }
  return ctx.locator(selectors[selectors.length - 1]).first();
};

const findCardPaymentFrame = (page) =>
  page.frames().find((f) => {
    const u = f.url() || "";
    return /new-claro-recarga\.html|eldorado\.m4u\.com\.br\/bsc\/checkout/i.test(u);
  }) ?? null;

const isPanFormReady = async (page) => Boolean(await findCardFormContext(page));

/** Bug UI Claro: iframe PAN só monta após sair da tela e voltar (Recarga → Dados → cartão). */
const refreshCardFormViaTabs = async (page, session) => {
  if (session && isWebPortalSession(session)) {
    return;
  }
  setSessionStep(session, "refresh_pan_iframe", "Recarga → Dados para carregar formulário do cartão…");
  await closeSnackbarIfVisible(page);
  await dismissCookieBanner(page);
  if (isNlogPortal()) {
    await page.goto(config.meusDadosUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await sleep(700);
    await clickByText(page, NEW_CARD_LABELS, Math.max(config.actionTimeoutMs, 12000));
    await sleep(config.cardFormSettleMs > 0 ? config.cardFormSettleMs : 900);
    return;
  }
  if (await clickRecargaTab(page)) {
    await sleep(900);
    await dismissCookieBanner(page);
  }
  await clickByText(page, ["Dados"], 12000);
  await sleep(900);
  if (!(await clickByText(page, ["Cadastrar cartão de crédito", "Cadastrar cartao de credito"], 10000))) {
    await clickByText(page, NEW_CARD_LABELS, 8000).catch(() => {});
    await sleep(600);
    await clickByText(page, ["Cadastrar cartão de crédito", "Cadastrar cartao de credito"], 10000);
  }
  const settle = config.cardFormSettleMs > 0 ? config.cardFormSettleMs : 1200;
  await sleep(settle);
};

const getCardContext = async (page) => {
  const deadline = Date.now() + config.cardIframeTimeoutMs;
  while (Date.now() < deadline) {
    const frame = findCardPaymentFrame(page);
    if (frame) return frame;
    await sleep(300);
  }
  return page;
};

/** Aguarda iframe + PAN visível (Smart Checkout Eldorado pode demorar ~10–30s). */
const waitForCardFormReady = async (page, session = null) => {
  const timeoutMs =
    session && isWebPortalSession(session)
      ? Math.max(config.cardFormReadyTimeoutMs, config.cardIframeTimeoutMs, 45000)
      : config.cardFormReadyTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  let lastLog = 0;
  let kicked = false;
  const kickAt = Date.now() + Math.min(7000, Math.floor(timeoutMs * 0.4));
  while (Date.now() < deadline) {
    const ctx = await findCardFormContext(page);
    if (ctx) return ctx;

    // Smart Checkout: iframe externo monta antes do new-claro-recarga interno
    if (session && isWebPortalSession(session)) {
      const checkout = page.locator('iframe#checkout, iframe[title="smartCheckout"]').first();
      if ((await checkout.count()) > 0) {
        try {
          await checkout.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
        } catch {
          // ignore
        }
      }
    }

    if (!kicked && session && !isWebPortalSession(session) && Date.now() >= kickAt) {
      kicked = true;
      console.log("[claro] PAN ainda não montou — Recarga → Dados (kick iframe)…");
      await refreshCardFormViaTabs(page, session);
      lastLog = 0;
      continue;
    }
    if (Date.now() - lastLog > 2500) {
      console.log(`[claro] Aguardando PAN no iframe do cartão (até ${timeoutMs}ms)...`);
      lastLog = Date.now();
    }
    await sleep(350);
  }
  throw new Error(
    `Campo PAN (#pan) não ficou pronto em ${timeoutMs}ms. Aumente CARD_FORM_READY_TIMEOUT_MS no .env se o PC for lento.`
  );
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex tolerante a acentos (opções/opcoes, cartão/cartao). */
const textToFlexibleRegex = (text) => {
  const map = {
    a: "[aáàâãä]",
    e: "[eéèêë]",
    i: "[iíìîï]",
    o: "[oóòôõö]",
    u: "[uúùûü]",
    c: "[cç]",
    A: "[AÁÀÂÃÄ]",
    E: "[EÉÈÊË]",
    I: "[IÍÌÎÏ]",
    O: "[OÓÒÔÕÖ]",
    U: "[UÚÙÛÜ]",
    C: "[CÇ]"
  };
  let out = "";
  for (const ch of String(text)) {
    if (map[ch]) out += map[ch];
    else if (/\s/.test(ch)) out += "\\s+";
    else out += escapeRegex(ch);
  }
  return new RegExp(out, "i");
};

const clickByText = async (page, texts, timeoutMs = config.actionTimeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await dismissCookieBanner(page);
    try {
      await dismissBonusModalIfVisible(page);
    } catch {
      // ignore
    }

    // Nunca estourar 25s de ELEMENT_CLICK_TIMEOUT dentro de um timeout curto do caller.
    const clickMs = Math.max(400, Math.min(2500, deadline - Date.now()));

    for (const text of texts) {
      const re = textToFlexibleRegex(text);
      // Evita clicar em "Gerenciar cookies" (OneTrust) quando procuramos Gerenciar recarga.
      if (/gerenciar/i.test(text) && /recarga/i.test(text)) {
        const gerenciarBtn = page
          .getByRole("button", { name: /gerenciar\s+recarga/i })
          .or(page.getByRole("link", { name: /gerenciar\s+recarga/i }))
          .or(page.getByText(/gerenciar\s+recarga/i))
          .first();
        try {
          if ((await gerenciarBtn.count()) > 0 && (await gerenciarBtn.isVisible().catch(() => false))) {
            const label = ((await gerenciarBtn.innerText().catch(() => "")) || "").toLowerCase();
            if (!label.includes("cookie")) {
              await gerenciarBtn.click({ timeout: clickMs, force: true });
              return true;
            }
          }
        } catch {
          // segue para candidatos genéricos
        }
      }

      const candidates = [
        page.getByRole("button", { name: re }).first(),
        page.getByRole("link", { name: re }).first(),
        page.getByRole("tab", { name: re }).first(),
        page.locator("button, a, [role='button'], label, div[class*='Button'], span").filter({ hasText: re }).first(),
        page.getByText(re).first()
      ];

      for (const locator of candidates) {
        try {
          if ((await locator.count()) === 0) continue;
          if (!(await locator.isVisible().catch(() => false))) continue;
          const label = ((await locator.innerText().catch(() => "")) || "").toLowerCase();
          if (label.includes("cookie")) continue;
          await locator.scrollIntoViewIfNeeded().catch(() => {});
          await locator.click({ timeout: clickMs });
          return true;
        } catch {
          // tenta próximo candidato
        }
      }
    }
    await sleep(200);
  }
  return false;
};

const saveStepDebug = async (page, tag) => {
  try {
    const stamp = Date.now();
    const base = path.join(CLARO_DEBUG_DIR, `step_${tag}_${stamp}`);
    await fs.mkdir(CLARO_DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    await fs.writeFile(`${base}.html`, await page.content(), "utf8").catch(() => {});
    console.log(`[claro][debug] ${tag} url=${page.url()} -> ${base}.png`);
  } catch (err) {
    console.warn(`[claro][debug] falha ${tag}: ${err?.message || err}`);
  }
};

const frameEvalWithTimeout = async (frame, fn, timeoutMs = 2500) =>
  Promise.race([
    frame.evaluate(fn),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`frame evaluate timeout (${timeoutMs}ms)`)), timeoutMs)
    )
  ]);

/** Evita locator.count() travar quando dezenas de iframes Bemobi estão carregando. */
const withTimeout = async (promise, timeoutMs, fallback = null) =>
  Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs))
  ]);

const locatorCountSafe = async (locator, timeoutMs = 1500) => {
  const n = await withTimeout(locator.count().catch(() => 0), timeoutMs, 0);
  return typeof n === "number" ? n : 0;
};

/** cs / web-link: captura HTML + PNG + textos/botões de cada iframe (debug do fluxo). */
const captureWebLinkStep = async (page, tag, session = null) => {
  if (process.env.SKIP_CS_CAPTURE === "1") return;
  try {
    const stamp = Date.now();
    const prefix = session?.accessNumber ? `${session.accessNumber}_` : "";
    const base = path.join(CLARO_DEBUG_DIR, `cs_${prefix}${tag}_${stamp}`);
    await fs.mkdir(CLARO_DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: `${base}.png`, fullPage: true, timeout: 8000 }).catch(() => {});
    await fs
      .writeFile(`${base}.html`, await page.content({ timeout: 8000 }).catch(() => ""), "utf8")
      .catch(() => {});

    const framesDump = [];
    for (const frame of page.frames()) {
      try {
        const url = frame.url() || "";
        const meta = await frameEvalWithTimeout(
          frame,
          () => {
            const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
            const buttons = [...document.querySelectorAll("button, a, [role='button'], label, [role='radio']")]
              .map((el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())
              .filter((t) => t && t.length < 100);
            const inputs = [...document.querySelectorAll("input, select, textarea")]
              .map((el) => ({
                id: el.id || null,
                name: el.name || null,
                type: el.type || el.tagName,
                placeholder: el.placeholder || null,
                autocomplete: el.autocomplete || null,
                visible: el.offsetWidth > 0 && el.offsetHeight > 0
              }))
              .slice(0, 30);
            return {
              textPreview: text.slice(0, 2000),
              buttons: [...new Set(buttons)].slice(0, 50),
              inputs
            };
          },
          2500
        );
        framesDump.push({ url, ...meta });
      } catch (err) {
        framesDump.push({ url: frame.url() || "", error: String(err?.message || err) });
      }
    }
    await fs.writeFile(`${base}_frames.json`, JSON.stringify(framesDump, null, 2), "utf8");
    console.log(`[claro][cs-capture] ${tag} url=${page.url()} -> ${base}.* (${framesDump.length} frames)`);
  } catch (err) {
    console.warn(`[claro][cs-capture] falha ${tag}: ${err?.message || err}`);
  }
};

const visibleTextMatch = async (page, pattern) => {
  try {
    const loc = page.getByText(pattern).first();
    return (await loc.count()) > 0;
  } catch {
    return false;
  }
};

const readSnackbarText = async (page) => {
  const sels = [
    ".snackbar__text",
    ".snackbar",
    "[class*='snackbar']",
    "[role='alert']",
    ".toast",
    "[class*='Toast']"
  ];
  for (const sel of sels) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      const t = (await loc.innerText({ timeout: 800 })).replace(/\s+/g, " ").trim();
      if (t) return t.slice(0, 240);
    } catch {
      // next
    }
  }
  return "";
};

const m4uSessionAuthenticated = (session) => {
  if (session?.smsM4uOk) return true;
  if (!session?.m4uAuthCapture) return false;
  const m4u = session.m4uAuthCapture.lastSessions?.();
  if (!m4u || Date.now() - m4u.ts > 120000) return false;
  return m4u.status === 200 && Boolean(m4u.bodyJson?.id);
};

/** SMS aceito (M4U ou storageState já persistido após código). */
const postSmsAuthOk = (session) =>
  m4uSessionAuthenticated(session) || Boolean(session?.smsAuthenticated);

const markM4uSessionOk = (session) => {
  if (session) session.smsM4uOk = true;
};

const syncM4uOkFromCapture = (session) => {
  const m4u = session?.m4uAuthCapture?.lastSessions?.();
  if (m4u?.status === 200) markM4uSessionOk(session);
};

const m4uCustomerExists = (session) => {
  const c = session?.m4uAuthCapture?.lastCustomer?.();
  return c?.status === 200;
};

/** Campo de número vazio = Claro realmente pediu login de novo (não transição pós-SMS). */
const landingPhoneFieldEmpty = async (page) => {
  const selectors = [
    'input[placeholder*="Digite seu nº claro"]',
    'input[placeholder*="Digite seu n"]'
  ];
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    if ((await loc.count()) === 0) continue;
    try {
      const val = (await loc.inputValue({ timeout: 800 })).replace(/\D/g, "");
      return val.length < 10;
    } catch {
      return true;
    }
  }
  return false;
};

const isVisualLandingLogin = async (page) => {
  if (await hasAuthenticatedUiMarkers(page)) return false;
  const hasPhonePlaceholder =
    (await page.locator('input[placeholder*="Digite seu nº claro"]').count()) > 0 ||
    (await page.locator('input[placeholder*="Digite seu n"]').count()) > 0;
  if (!hasPhonePlaceholder) return false;
  const hasGerenciar = await visibleTextMatch(page, /Gerenciar\s+recarga/i);
  const hasCodeField =
    (await page.locator('input[placeholder*="Digite o código"]').count()) > 0 ||
    (await page.locator('input[placeholder*="Digite o codigo"]').count()) > 0;
  if (hasCodeField || !hasGerenciar) return false;
  return landingPhoneFieldEmpty(page);
};

const isBackOnLandingLogin = async (page, session = null) => {
  if (session && postSmsAuthOk(session)) return false;
  return isVisualLandingLogin(page);
};

/** UI autenticada de verdade (marcadores positivos — não chama isBackOnLandingLogin). */
const hasAuthenticatedUiMarkers = async (page) => {
  const url = page.url() || "";
  if (/\/minhaclaro_app_nlog\/(numero|pagamento-cartao|meus-dados|criar-cartao|home)/i.test(url)) return true;
  if (/\/minhaclaro_web\/(numero|pagamento|meus-dados|criar-cartao|home|landing)/i.test(url)) return true;
  return (
    (await visibleTextMatch(page, /Escolha um valor de recarga/i)) ||
    (await visibleTextMatch(page, /Escolha um n[uú]mero Claro/i)) ||
    (await visibleTextMatch(page, /Resumo da recarga/i)) ||
    (await visibleTextMatch(page, /Outras\s+Op/i)) ||
    (await visibleTextMatch(page, /Fazer\s+recarga/i)) ||
    (await visibleTextMatch(page, /Cadastrar\s+novo\s+cart/i)) ||
    (await visibleTextMatch(page, /Meus\s+dados|meus-dados/i)) ||
    ((await visibleTextMatch(page, /^Recarga$/i)) && (await visibleTextMatch(page, /^Dados$/i)))
  );
};

const waitForAuthenticatedUi = async (page, timeoutMs = 10000, session = null) => {
  if (session && m4uSessionAuthenticated(session)) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session && m4uSessionAuthenticated(session)) return true;
    if (await isBackOnLandingLogin(page, session)) return false;
    if (await hasAuthenticatedUiMarkers(page)) return true;
    await sleep(350);
  }
  return (
    (await hasAuthenticatedUiMarkers(page)) && !(await isBackOnLandingLogin(page, session))
  );
};

const markAuthLost = (session) => {
  if (!session) return;
  session.smsAuthenticated = false;
  session.smsM4uOk = false;
  session.canRetryWithoutSms = false;
  session.status = "auth_expired";
};

/**
 * Após Continuar do SMS: detecta código inválido / sessão expirada
 * (Claro costuma jogar de volta pro landing com número vazio).
 */
const assertAuthSurvivedAfterCode = async (page, session) => {
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    if (m4uSessionAuthenticated(session)) return;

    const m4u = session?.m4uAuthCapture?.lastSessions?.();
    if (m4u?.status === 400) {
      markAuthLost(session);
      throw claroFlowError(
        "sms_invalid",
        "Código SMS incorreto ou expirado (API Claro: 400 Bad Request)."
      );
    }
    if (m4u?.status === 200 && m4u.bodyJson?.id) {
      markM4uSessionOk(session);
      return;
    }

    const snack = await readSnackbarText(page);
    if (
      snack &&
      /c[oó]digo|inv[aá]lid|incorret|expir|n[aã]o\s+confere|tent|sms|autentic/i.test(snack)
    ) {
      markAuthLost(session);
      throw claroFlowError("sms_invalid", `Código SMS rejeitado pela Claro: ${snack}`);
    }

    const onLanding = await isBackOnLandingLogin(page, session);
    if (
      !onLanding &&
      ((await visibleTextMatch(page, /Outras\s+Op/i)) ||
        (await visibleTextMatch(page, /Cadastrar\s+novo\s+cart/i)) ||
        (await visibleTextMatch(page, /^Dados$/i)) ||
        (await visibleTextMatch(page, /Fazer\s+recarga/i)) ||
        (await visibleTextMatch(page, /Escolha um valor de recarga/i)) ||
        (await visibleTextMatch(page, /Escolha um n[uú]mero Claro/i)) ||
        (await visibleTextMatch(page, /Resumo da recarga/i)))
    ) {
      syncM4uOkFromCapture(session);
      return;
    }
    if (onLanding && Date.now() > deadline - 12000) {
      const hint = snack ? ` snackbar="${snack}"` : "";
      markAuthLost(session);
      throw claroFlowError(
        "sms_invalid",
        `Código SMS inválido ou sessão expirada — voltou para a tela inicial.${hint}`
      );
    }
    await sleep(400);
  }
  if (m4uSessionAuthenticated(session)) return;
  const late = session?.m4uAuthCapture?.lastSessions?.();
  if (late?.status === 400) {
    markAuthLost(session);
    throw claroFlowError("sms_invalid", "Código SMS incorreto ou expirado (API Claro: 400 Bad Request).");
  }
  if (late?.status === 200 && late.bodyJson?.id) {
    markM4uSessionOk(session);
    return;
  }
  if (await isBackOnLandingLogin(page, session)) {
    markAuthLost(session);
    throw claroFlowError(
      "sms_invalid",
      "Código SMS inválido ou sessão expirada — voltou para a tela inicial."
    );
  }
};

const leaveLandingAfterSmsOk = async (session) => {
  const { page } = session;
  const smsOk = m4uSessionAuthenticated(session);

  setSessionStep(session, "pos_sms_home", "Aguardando home após SMS…");
  for (let i = 0; i < 50; i++) {
    if (await hasAuthenticatedUiMarkers(page)) return;
    await sleep(400);
  }

  if (!smsOk) return;

  if (isNlogPortal()) {
    setSessionStep(session, "nlog_meus_dados", "Indo para Meus Dados (cadastro de cartão)…");
    await page
      .goto(config.meusDadosUrl, { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    await dismissCookieBanner(page);
    await waitForAuthenticatedUi(page, 15000, session);
  }
  // Cadastro: meus-dados → cadastrar cartão → recarga (whatsapp e nlog).
};

const fillFirstVisible = async (
  page,
  selectors,
  value,
  timeoutMs = config.actionTimeoutMs
) => {
  const deadline = Date.now() + timeoutMs;
  // Em cada ciclo tenta TODOS os seletores — antes o 1º esgotava o timeout sozinho (~25s).
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const locator = page.locator(selector).first();
        if ((await locator.count()) === 0) continue;
        if (!(await locator.isVisible().catch(() => false))) continue;
        await locator.fill(value, { timeout: Math.min(8000, config.elementClickTimeoutMs) });
        return true;
      } catch {
        // próximo seletor
      }
    }
    await sleep(200);
  }
  return false;
};

const clickContinuar = async (page, timeoutMs = config.actionTimeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const buttonByRole = page.getByRole("button", { name: /continuar/i }).first();
    if ((await buttonByRole.count()) > 0) {
      await buttonByRole.click({ timeout: config.elementClickTimeoutMs });
      return true;
    }

    const buttonByText = page.getByText("Continuar", { exact: false }).first();
    if ((await buttonByText.count()) > 0) {
      await buttonByText.click({ timeout: config.elementClickTimeoutMs });
      return true;
    }
    await sleep(250);
  }
  return false;
};

const clickContinuarWhenEnabled = async (page, timeoutMs = config.actionTimeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const buttonByRole = page.getByRole("button", { name: /continuar/i }).first();
    if ((await buttonByRole.count()) > 0) {
      try {
        if (!(await buttonByRole.isDisabled())) {
          await buttonByRole.click({ timeout: config.elementClickTimeoutMs });
          return true;
        }
      } catch {
        // retry
      }
    }
    await sleep(300);
  }
  return clickContinuar(page, Math.max(5000, timeoutMs - 5000));
};

const delayStep = async (step) => {
  await sleep(getStepDelay(step));
};

const typeHumanLike = async (page, text) => {
  await page.keyboard.type(String(text), { delay: config.pamTypingDelayMs });
};

const waitForCardSaved = async (page) => {
  const options = [
    page.locator(".snackbar__text").filter({ hasText: /cart[aã]o cadastrado com sucesso/i }).first(),
    page.getByText(/cart[aã]o cadastrado com sucesso/i).first()
  ];

  for (const locator of options) {
    try {
      await locator.waitFor({ timeout: config.actionTimeoutMs });
      return true;
    } catch {
      // Tenta próxima estratégia
    }
  }

  return false;
};

const fillCardFormDirectly = async (page, pam, session = null) => {
  const cardWaitMs =
    session && isWebPortalSession(session)
      ? Math.max(config.cardFormReadyTimeoutMs, config.cardIframeTimeoutMs, 45000)
      : config.cardFormReadyTimeoutMs;
  console.log(`[claro] Aguardando formulário do cartão (PAN), timeout ${cardWaitMs}ms...`);
  const ctx = await waitForCardFormReady(page, session);
  const eldorado = isEldoradoCheckoutUrl(ctx.url());
  const panInput = await resolveLocator(ctx, CARD_PAN_SELECTORS);
  const expirationInput = await resolveLocator(ctx, CARD_EXP_SELECTORS);
  const cvvInput = await resolveLocator(ctx, CARD_CVV_SELECTORS);
  const holderInput = await resolveLocator(ctx, CARD_HOLDER_SELECTORS);
  const panContainer = ctx.locator('div[name="pan"]').first();
  const waitState = eldorado ? "attached" : "visible";

  await panInput.waitFor({ state: waitState, timeout: cardWaitMs });
  await expirationInput.waitFor({ state: waitState, timeout: cardWaitMs });
  await cvvInput.waitFor({ state: waitState, timeout: cardWaitMs });
  await holderInput.waitFor({ state: waitState, timeout: cardWaitMs });
  if (!eldorado && (await panContainer.count()) > 0) {
    await panContainer.waitFor({ state: "visible", timeout: cardWaitMs });
  }

  await ctx.evaluate(() => {
    const panDiv = document.querySelector('div[name="pan"]');
    if (panDiv) {
      panDiv.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
    const input =
      document.querySelector("#pan") ||
      document.querySelector('input[name="pan"]') ||
      document.querySelector('input[data-cy="pan"]') ||
      document.querySelector('input[autocomplete="cc-number"]');
    if (input instanceof HTMLInputElement) {
      input.focus();
    }
  });
  await panInput.fill("", { force: true });
  await panInput.fill(String(pam.pan).replace(/\D/g, ""), { force: true });

  await ctx.evaluate(() => {
    const input =
      document.querySelector("#expiration") ||
      document.querySelector('input[name="expirationDate"]') ||
      document.querySelector('input[autocomplete="cc-exp"]');
    if (input instanceof HTMLInputElement) {
      input.focus();
    }
  });
  await expirationInput.fill("", { force: true });
  await expirationInput.type(String(pam.mmYY), { delay: config.pamTypingDelayMs, force: true });

  await cvvInput.fill("", { force: true });
  await cvvInput.fill(String(pam.cvv || config.defaultCvv), { force: true });

  await holderInput.fill("", { force: true });
  await holderInput.type(String(randomName(config.defaultCardholderMaxLen)), {
    delay: config.pamTypingDelayMs,
    force: true
  });
};

const closeSnackbarIfVisible = async (page) => {
  const closeByText = page.getByText("×", { exact: true }).first();
  if ((await closeByText.count()) > 0) {
    try {
      await closeByText.click({ timeout: 1500 });
      return;
    } catch {
      // Ignora
    }
  }

  const closeByButton = page
    .locator(".snackbar button, .snackbar__close, [class*='snackbar'] button")
    .first();
  if ((await closeByButton.count()) > 0) {
    try {
      await closeByButton.click({ timeout: 1500 });
    } catch {
      // Ignora
    }
  }
};

const dismissBonusModalIfVisible = async (page) => {
  const dismissOptions = [
    page.getByRole("button", { name: /agora n[aã]o/i }).first(),
    page.locator("button.sc-gsxnyZ").filter({ hasText: "Agora não" }).first(),
    page.locator("button.sc-gsxnyZ").filter({ hasText: "Agora nao" }).first(),
    page.getByText("Agora não", { exact: false }).first(),
    page.getByText("Agora nao", { exact: false }).first()
  ];

  for (const option of dismissOptions) {
    if ((await option.count()) > 0) {
      try {
        await option.click({ timeout: 2000 });
        await sleep(250);
        return true;
      } catch {
        // tenta próximo seletor
      }
    }
  }
  return false;
};

const clickFinalRecarregar = async (page) => {
  const candidates = [
    page
      .locator("button.sc-hJxCPi, button.sc-iwyYcG")
      .filter({ hasText: "Recarregar" })
      .last(),
    page.locator("button:has-text('Recarregar')").last(),
    page.getByRole("button", { name: /recarregar/i }).last()
  ];

  for (const btn of candidates) {
    if ((await btn.count()) === 0) continue;
    try {
      await btn.scrollIntoViewIfNeeded();
      await btn.waitFor({ timeout: config.actionTimeoutMs });
      await btn.click({ timeout: config.actionTimeoutMs });
      return true;
    } catch {
      // tenta próximo fallback
    }
  }

  return false;
};

/** Após escolher Cartão de Crédito — botão Recarregar que abre o CVV (não o final). */
const clickPrimeiroRecarregar = async (page, timeoutMs = Math.max(config.actionTimeoutMs, 25000)) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await dismissCookieBanner(page);
    try {
      await dismissBonusModalIfVisible(page);
    } catch {
      // ignore
    }
    const candidates = [
      page
        .locator("button.sc-hJxCPi, button.sc-iwyYcG, button")
        .filter({ hasText: /^Recarregar$/i })
        .first(),
      page.getByRole("button", { name: /^Recarregar$/i }).first(),
      page.locator("button:has-text('Recarregar')").first(),
      page.getByRole("button", { name: /recarregar/i }).first()
    ];
    for (const btn of candidates) {
      try {
        if ((await btn.count()) === 0) continue;
        if (!(await btn.isVisible().catch(() => false))) continue;
        if (!(await btn.isEnabled().catch(() => true))) continue;
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click({ timeout: 2500 });
        return true;
      } catch {
        // próximo
      }
    }
    if (await clickByText(page, ["Recarregar"], 800)) return true;
    await sleep(300);
  }
  return false;
};

const isRechargesHistoryList = (url, body) =>
  Array.isArray(body) &&
  /\/recharges\b/i.test(String(url || "")) &&
  !/\/recharges\/result/i.test(String(url || ""));

const gateIndicatesSuccess = (gateResponse) => {
  const b = gateResponse?.body;
  const u = String(gateResponse?.url || "");
  if (Array.isArray(b) && b.length) {
    // GET /recharges = histórico (Pix ok+nsu antigos) — não é pagamento cartão em curso.
    if (isRechargesHistoryList(u, b)) return false;
    const latest = b[0];
    if (/^ok$/i.test(String(latest?.status || "")) && latest?.paymentMethod?.nsu) return true;
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) return false;
  if (/^CONFIRMED$/i.test(String(b.status || ""))) return true;
  if (b.payments?.[0]?.status === "CONFIRMED" && b.payments[0]?.nsu != null) return true;
  if (/^ok$/i.test(String(b.status || "")) && (b.nsuPayment || b.data?.payment?.nsu || b.data?.reload?.nsu)) {
    return true;
  }
  const benefits = b.data?.benefits;
  return Array.isArray(benefits) && benefits.some((x) => /^confirmed$/i.test(String(x?.status || "")));
};

const gateIndicatesError = (gateResponse) => {
  const b = gateResponse?.body;
  const u = String(gateResponse?.url || "");
  if (!b) return false;
  // GET /recharges lista tentativas — nok não é recusa final do pagamento em curso.
  if (Array.isArray(b) && /\/recharges\b/i.test(u)) return false;
  if (b.status === "DENIED" || b.payments?.[0]?.status === "DENIED") return true;
  if (b.tags?.transaction?.status === "DENIED" || b.tags?.status === "DENIED") return true;
  if (b.tags?.transaction?.reason) return true;
  if (Array.isArray(b) && b[0]?.status === "nok") return true;
  if (b.data?.errors?.length || b.errors?.length) return true;
  if (b.exception) return true;
  return false;
};

const anyCaptureIndicatesSuccess = (gateCapture) => {
  const caps = gateCapture?.captures || [];
  for (let i = caps.length - 1; i >= 0; i -= 1) {
    if (gateIndicatesSuccess(caps[i])) return caps[i];
  }
  return null;
};

const isDefinitivePaymentCapture = (capture) =>
  /\/api-bsc\/api\/v1\/payments/i.test(String(capture?.url || ""));

/** Recusa final Eldorado (/payments SSE ou POST) — não confundir com nok em GET /recharges. */
const anyCaptureIndicatesDenied = (gateCapture) => {
  const caps = gateCapture?.captures || [];
  let latest = null;
  for (const c of caps) {
    if (!isDefinitivePaymentCapture(c)) continue;
    if (!gateIndicatesError(c)) continue;
    if (!latest || c.ts > latest.ts) latest = c;
  }
  return latest;
};

const resolveGatePaymentOutcome = (gateCapture) => {
  if (!gateCapture) return null;
  const okCap = anyCaptureIndicatesSuccess(gateCapture);
  const deniedCap = anyCaptureIndicatesDenied(gateCapture);
  if (okCap && deniedCap) {
    return okCap.ts >= deniedCap.ts
      ? { kind: "success", cap: okCap }
      : { kind: "error", cap: deniedCap };
  }
  if (okCap) return { kind: "success", cap: okCap };
  if (deniedCap) return { kind: "error", cap: deniedCap };
  return null;
};

const extractGateNsu = (gateResponse, gate) => {
  if (gate?.nsu) return gate.nsu;
  const b = gateResponse?.body;
  const u = String(gateResponse?.url || "");
  if (Array.isArray(b) && b[0]?.paymentMethod?.nsu != null) {
    if (isRechargesHistoryList(u, b)) return null;
    return String(b[0].paymentMethod.nsu);
  }
  if (b?.payments?.[0]?.nsu != null) return String(b.payments[0].nsu);
  if (b?.nsuPayment) return String(b.nsuPayment);
  if (b?.data?.payment?.nsu) return String(b.data.payment.nsu);
  return null;
};

const buildPaymentResult = async (page, status, currentUrl, gateCapture, pageHint = "") => {
  // Pequena espera para XHR da gate terminar depois do redirect.
  await sleep(1200);
  let gateResponse = gateCapture?.best?.() || null;
  if (gateCapture) {
    if (status === "error") {
      const deniedCap = anyCaptureIndicatesDenied(gateCapture);
      if (deniedCap) gateResponse = deniedCap;
    } else if (status === "success") {
      const okCap = anyCaptureIndicatesSuccess(gateCapture);
      if (okCap) gateResponse = okCap;
    }
  }
  const gate = summarizeGateCapture(gateResponse);
  const gateNsu = extractGateNsu(gateResponse, gate);
  await persistGateDebug(gateResponse, status, gateCapture);

  if (status === "error") {
    const message =
      gate.summary ||
      gate.message ||
      pageHint ||
      "Pagamento recusado (Claro)";
    return {
      status: "error",
      url: currentUrl,
      message,
      pagamentoErro: true,
      pageHint,
      gateCode: gate.code,
      gateMessage: gate.message || gate.summary || null,
      gateNsu,
      gateResponse
    };
  }

  if (status === "success") {
    const proved = gateIndicatesSuccess(gateResponse) || isPaymentSuccessUrl(currentUrl);
    if (!proved) {
      return {
        status: "error",
        url: currentUrl,
        message: pageHint || "Pagamento não confirmado pela gate Claro.",
        pagamentoErro: true,
        pageHint,
        gateCode: gate.code,
        gateMessage: gate.message || gate.summary || null,
        gateNsu: null,
        gateResponse
      };
    }
    const msg =
      gateNsu
        ? `Pagamento confirmado (nsu=${gateNsu})`
        : gate.summary || gate.message || "Pagamento confirmado com sucesso";
    return {
      status: "success",
      url: currentUrl,
      message: msg,
      gateCode: gate.code,
      gateMessage: gate.message || gate.summary || (gateNsu ? `nsu=${gateNsu}` : null),
      gateNsu,
      gateResponse
    };
  }

  if (status === "timeout" && gateIndicatesSuccess(gateResponse)) {
    return {
      status: "success",
      url: currentUrl || page.url(),
      message: gateNsu ? `Pagamento confirmado (nsu=${gateNsu})` : "Pagamento confirmado com sucesso",
      gateCode: gate.code,
      gateMessage: gate.message || gate.summary || (gateNsu ? `nsu=${gateNsu}` : null),
      gateNsu,
      gateResponse
    };
  }

  if (status === "timeout" && gateIndicatesError(gateResponse)) {
    return {
      status: "error",
      url: currentUrl || page.url(),
      message: gate.summary || gate.message || "Pagamento recusado (Claro)",
      pagamentoErro: true,
      gateCode: gate.code,
      gateMessage: gate.message || gate.summary || null,
      gateNsu,
      gateResponse
    };
  }

  if (status === "timeout") {
    return {
      status: "timeout",
      url: page.url(),
      message: gate.summary || "Timeout aguardando resultado do pagamento",
      gateCode: gate.code,
      gateMessage: gate.message || gate.summary || null,
      gateNsu,
      gateResponse
    };
  }

  if (status === "3ds_blocked") {
    const tds = gateCapture ? gateCaptureHas3dsChallenge(gateCapture) : null;
    const brand =
      tds?.brand ??
      pageHint?.match(/(Bradesco|Visa|Master|Elo|Ita[uú]|Santander|CARD|banco)/i)?.[1] ??
      "banco";
    return {
      status: "3ds_blocked",
      url: currentUrl || page.url(),
      message: `3DS exigido pelo emissor (${brand}) — recarga abortada`,
      gateCode: "3DS_BLOCKED",
      gateMessage: `Autenticação 3DS ${brand} — não suportada`,
      threeDS: true,
      pageHint,
      gateNsu,
      gateResponse
    };
  }

  return {
    status: "timeout",
    url: page.url(),
    message: gate.summary || "Timeout aguardando resultado do pagamento",
    gateCode: gate.code,
    gateMessage: gate.message || gate.summary || null,
    gateNsu,
    gateResponse
  };
};

const PAYMENT_ERROR_TEXT_RE =
  /n[aã]o conseguimos processar|n[aã]o foi poss[ií]vel processar|pagamento recusad|transa[cç][aã]o negad|cart[aã]o recusad|algo deu errado/i;
const PAYMENT_SUCCESS_TEXT_RE =
  /recarga realizada|pagamento aprovad|recarga efetuada|sucesso na recarga|obrigado pela recarga|pronto!\s*sua recarga/i;

const scanPageForPaymentOutcome = async (page) => {
  for (const frame of page.frames()) {
    try {
      const text = await frame.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim());
      if (!text) continue;
      if (PAYMENT_ERROR_TEXT_RE.test(text)) {
        return { status: "error", hint: text.slice(0, 500) };
      }
      if (PAYMENT_SUCCESS_TEXT_RE.test(text)) {
        return { status: "success", hint: text.slice(0, 500) };
      }
    } catch {
      // cross-origin / frame morto
    }
  }
  try {
    const text = (await page.locator("body").innerText({ timeout: 1500 })).replace(/\s+/g, " ").trim();
    if (PAYMENT_ERROR_TEXT_RE.test(text)) return { status: "error", hint: text.slice(0, 500) };
    if (PAYMENT_SUCCESS_TEXT_RE.test(text)) return { status: "success", hint: text.slice(0, 500) };
  } catch {
    // ignore
  }
  return null;
};

const PAGE_3DS_TEXT_RE =
  /valida[cç][aã]o de seguran[cç]a|chave de seguran[cç]a|verifica[cç][aã]o necess[aá]ria|threeDSSessionData|bpmpi_auth/i;

const scanPageFor3dsChallenge = async (page) => {
  for (const frame of page.frames()) {
    try {
      const text = await frame.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim());
      if (text && PAGE_3DS_TEXT_RE.test(text)) {
        const brand = text.match(/(Bradesco|Visa|Master|Elo|Ita[uú]|Santander)/i)?.[1] ?? "banco";
        return { brand, hint: text.slice(0, 300) };
      }
      const has3dsInput = await frame
        .locator('input[name="threeDSSessionData"], input[name="bpmpi_auth_suppresschallenge"]')
        .count()
        .catch(() => 0);
      if (has3dsInput > 0) {
        return { brand: "CARD", hint: "formulário 3DS detectado" };
      }
    } catch {
      // cross-origin / frame morto
    }
  }
  return null;
};

const waitForPaymentResult = async (page, timeoutMs = config.paymentWaitTimeoutMs || 120000, gateCapture = null) => {
  const startTime = Date.now();
  const checkInterval = 500;

  while (Date.now() - startTime < timeoutMs) {
    const currentUrl = page.url();
    const outcome = gateCapture ? resolveGatePaymentOutcome(gateCapture) : null;

    if (outcome?.kind === "success") {
      return buildPaymentResult(page, "success", currentUrl, gateCapture);
    }
    if (outcome?.kind === "error") {
      return buildPaymentResult(page, "error", currentUrl, gateCapture);
    }

    const tdsNet = gateCapture ? gateCaptureHas3dsChallenge(gateCapture) : null;
    const tdsPage = await scanPageFor3dsChallenge(page);
    if (tdsNet || tdsPage) {
      const brand = tdsNet?.brand ?? tdsPage?.brand ?? "banco";
      console.log(`[claro][3ds] detectado (${brand}) — abortando pagamento`);
      return buildPaymentResult(
        page,
        "3ds_blocked",
        currentUrl,
        gateCapture,
        tdsPage?.hint || `Challenge 3DS ${brand}`
      );
    }

    const visible = await scanPageForPaymentOutcome(page);
    if (visible?.status === "success" && !isPaymentErrorUrl(currentUrl)) {
      const okCap = gateCapture ? anyCaptureIndicatesSuccess(gateCapture) : null;
      if (okCap || isPaymentSuccessUrl(currentUrl)) {
        return buildPaymentResult(page, "success", currentUrl, gateCapture, visible.hint);
      }
    }

    const gateBest = gateCapture?.best?.() || null;
    if (gateBest && gateIndicatesError(gateBest)) {
      const pending =
        /^PENDING$/i.test(String(gateBest.body?.status || "")) ||
        gateBest.body?.payments?.[0]?.status === "PENDING";
      if (!pending) {
        return buildPaymentResult(page, "error", currentUrl, gateCapture);
      }
    }

    if (visible?.status === "error" && !isPaymentSuccessUrl(currentUrl)) {
      return buildPaymentResult(page, "error", currentUrl, gateCapture, visible.hint);
    }

    if (isPaymentErrorUrl(currentUrl)) {
      let pageHint = "";
      try {
        pageHint = await page.locator("body").innerText({ timeout: config.elementClickTimeoutMs ?? 15000 });
        pageHint = pageHint.replace(/\s+/g, " ").trim().slice(0, 400);
      } catch {
        // ignora
      }
      return buildPaymentResult(page, "error", currentUrl, gateCapture, pageHint);
    }

    await sleep(checkInterval);
  }

  const finalOutcome = gateCapture ? resolveGatePaymentOutcome(gateCapture) : null;
  if (finalOutcome?.kind === "success") {
    return buildPaymentResult(page, "success", page.url(), gateCapture);
  }
  if (finalOutcome?.kind === "error") {
    return buildPaymentResult(page, "error", page.url(), gateCapture);
  }

  return buildPaymentResult(page, "timeout", page.url(), gateCapture);
};

const clickRecargaTab = async (page) => {
  // Preferir aba "Recarga" exata — /recarga/i pega "Fazer recarga" / "Outras Opções de Recarga" e bagunça o fluxo.
  const exactTab = page.getByRole("tab", { name: /^Recarga$/i }).first();
  if ((await exactTab.count()) > 0) {
    try {
      await exactTab.click({ timeout: config.elementClickTimeoutMs });
      return true;
    } catch {
      // fallback
    }
  }

  const byClass = page.locator("button.mdn-TabSelect-anchor", { hasText: /^Recarga$/i }).first();
  if ((await byClass.count()) > 0) {
    try {
      await byClass.click({ timeout: config.elementClickTimeoutMs });
      return true;
    } catch {
      // fallback
    }
  }

  const byRoleBtn = page.getByRole("button", { name: /^Recarga$/i }).first();
  if ((await byRoleBtn.count()) > 0) {
    try {
      await byRoleBtn.click({ timeout: config.elementClickTimeoutMs });
      return true;
    } catch {
      // fallback
    }
  }

  return clickByText(page, ["Recarga"]);
};

/** Após salvar cartão: fecha snackbar, vai à aba Recarga e clica Fazer recarga. */
const goToFazerRecargaAfterCard = async (page, session) => {
  await closeSnackbarIfVisible(page);
  await sleep(500);

  setSessionStep(session, "aba_recarga", "Abrindo aba Recarga…");
  let onRecarga = await clickRecargaTab(page);
  if (!onRecarga) {
    // Às vezes o snackbar/sucesso cobre a aba — tenta de novo.
    await closeSnackbarIfVisible(page);
    await sleep(400);
    onRecarga = await clickRecargaTab(page);
  }
  if (!onRecarga) {
    await saveStepDebug(page, "aba_recarga_fail");
    throw new Error("Aba Recarga não encontrada após cadastrar cartão.");
  }
  await delayStep(12);
  await dismissCookieBanner(page);
  await sleep(400);

  setSessionStep(session, "fazer_recarga", "Clicando em Fazer recarga…");
  const labels = ["Fazer recarga", "Fazer Recarga", "fazer recarga"];
  let clicked = await clickByText(page, labels, Math.max(config.actionTimeoutMs, 20000));
  if (!clicked) {
    // Ainda na aba Dados? força Recarga de novo.
    await clickRecargaTab(page);
    await sleep(600);
    clicked = await clickByText(page, labels, 15000);
  }
  if (!clicked) {
    await saveStepDebug(page, "fazer_recarga_fail");
    throw new Error("Botão Fazer recarga não encontrado.");
  }
};

/** Impede 2 fluxos no mesmo browser (ex.: double-click / submit+retry) — causava 2 cartões. */
const assertSessionNotBusy = (session, action) => {
  if (session.status === "running" || session.runLock) {
    throw new Error(
      `Sessão já em execução (${session.step || "running"}). Aguarde terminar antes de ${action}.`
    );
  }
};

const beginSessionRun = (session, action) => {
  assertSessionNotBusy(session, action);
  // Também bloqueia outro sessionId do mesmo número com browser vivo.
  const access = session.accessNumber;
  if (access) {
    for (const other of sessions.values()) {
      if (other.id === session.id) continue;
      if (other.accessNumber === access && (other.status === "running" || other.runLock) && sessionPageAlive(other)) {
        throw new Error(
          `Já existe fluxo em andamento para ${access}. Aguarde terminar (evita cadastrar 2 cartões).`
        );
      }
    }
  }
  session.runLock = true;
  session.status = "running";
};

const endSessionRun = (session) => {
  if (!session) return;
  session.runLock = false;
};

const dismissCookieBanner = async (page) => {
  // OneTrust Claro: "Aceitar cookies" (#onetrust-accept-btn-handler) costuma ser o visível;
  // "Permitir todos" às vezes existe no DOM mas está oculto no painel de preferências.
  const oneTrustCandidates = [
    page.locator("#onetrust-accept-btn-handler").first(),
    page.getByRole("button", { name: /aceitar\s+cookies/i }).first(),
    page.locator("#accept-recommended-btn-handler").first(),
    page.getByRole("button", { name: /permitir\s+todos/i }).first(),
    page.getByRole("button", { name: /aceitar\s+todos/i }).first(),
    page.locator("#onetrust-button-group button").first(),
    page.locator("#onetrust-reject-all-handler").first(),
    page.locator("#onetrust-close-btn-container button").first()
  ];

  for (const btn of oneTrustCandidates) {
    if ((await btn.count()) > 0) {
      try {
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 1200, force: true });
          await sleep(250);
          return true;
        }
      } catch {
        // tenta próximo
      }
    }
  }

  const cookieText = page.getByText(/cookies|privacidade/i).first();
  const hasCookieBanner = (await cookieText.count()) > 0;
  if (!hasCookieBanner) return false;

  const candidates = [
    page.getByRole("button", { name: /permitir/i }).first(),
    page.getByRole("button", { name: /aceitar/i }).first(),
    page.getByRole("button", { name: /concordo/i }).first(),
    page.getByRole("button", { name: /entendi/i }).first(),
    page.getByRole("button", { name: /ok/i }).first(),
    page.getByRole("button", { name: /fechar/i }).first(),
    page.locator('[aria-label*="cookie" i]').first(),
    page.locator('[data-testid*="cookie" i]').first()
  ];

  for (const candidate of candidates) {
    if ((await candidate.count()) > 0) {
      try {
        await candidate.click({ timeout: 2000 });
        await sleep(400);
        return true;
      } catch {
        // Tenta o próximo seletor
      }
    }
  }
  return false;
};

const saveClaroRadioDebug = async (page, tag) => {
  const stamp = Date.now();
  const base = path.join(CLARO_DEBUG_DIR, `claro_radio_${tag}_${stamp}`);
  await fs.mkdir(CLARO_DEBUG_DIR, { recursive: true });
  await page.screenshot({ path: `${base}.png`, fullPage: true });
  await fs.writeFile(`${base}.html`, await page.content(), "utf8");
  console.log(`[CLARO DEBUG] Artefatos salvos: ${base}.png / ${base}.html`);
  return base;
};

const detectInitialRadioState = async (page) => {
  const state = await page.evaluate(() => {
    const radios = [...document.querySelectorAll('input[type="radio"]')];
    return radios.map((radio, index) => {
      const container =
        radio.closest("label, div, section, article") || radio.parentElement;
      const text = (container?.innerText || "").trim().replace(/\s+/g, " ").slice(0, 160);
      return {
        index,
        checked: radio.checked,
        text,
        isOutro: /outro\s*n[uú]mero\s*claro/i.test(text)
      };
    });
  });
  console.log("[CLARO DEBUG] Estado inicial dos radios:", state);
  return state;
};

const verifyOutroNumeroClaroActive = async (page) => {
  const status = await page.evaluate(() => {
    const findOutroNumeroBlockInPage = () => {
      const blocks = [...document.querySelectorAll("label, div, section, article")].filter(
        (el) => {
          const t = (el.innerText || "").trim();
          if (!/outro\s*n[uú]mero\s*claro/i.test(t)) return false;
          if (t.length > 600) return false;
          return true;
        }
      );
      if (!blocks.length) return null;

      return blocks.sort((a, b) => {
        const aRadio = a.querySelector('input[type="radio"]') ? 0 : 1;
        const bRadio = b.querySelector('input[type="radio"]') ? 0 : 1;
        if (aRadio !== bRadio) return aRadio - bRadio;
        return (a.innerText || "").length - (b.innerText || "").length;
      })[0];
    };

    const targetBlock = findOutroNumeroBlockInPage();
    if (!targetBlock) {
      return { ok: false, reason: "Bloco Outro número Claro não encontrado na validação", radios: [] };
    }

    const radio =
      targetBlock.querySelector('input[type="radio"]') ||
      targetBlock.closest("label")?.querySelector('input[type="radio"]');

    const dddInput = [...document.querySelectorAll("input")].find((inp) => {
      const ph = (inp.placeholder || inp.getAttribute("aria-label") || "").toLowerCase();
      return ph.includes("ddd") && ph.includes("n");
    });

    const allRadios = [...document.querySelectorAll('input[type="radio"]')];
    const outroRadio = allRadios.find((r) => {
      const c = r.closest("label, div, section, article") || r.parentElement;
      return /outro\s*n[uú]mero\s*claro/i.test(c?.innerText || "");
    });

    const radioChecked = outroRadio ? outroRadio.checked : radio?.checked ?? false;
    const dddVisible =
      !!dddInput &&
      dddInput.offsetParent !== null &&
      !dddInput.disabled &&
      dddInput.getBoundingClientRect().height > 0;

    return {
      ok: radioChecked === true,
      reason:
        radioChecked === true
          ? "Radio Outro número Claro marcado"
          : "Radio Outro número Claro não está marcado",
      radioChecked,
      dddFieldVisible: dddVisible,
      blockText: (targetBlock.innerText || "").trim().slice(0, 200),
      radios: allRadios.map((r, i) => {
        const c = r.closest("label, div, section, article") || r.parentElement;
        return {
          index: i,
          checked: r.checked,
          text: (c?.innerText || "").trim().replace(/\s+/g, " ").slice(0, 100)
        };
      })
    };
  });

  console.log("[CLARO DEBUG] Validação pós-clique:", status);
  return status;
};

const selecionarOutroNumeroClaro = async (page) => {
  console.log("[CLARO DEBUG] Tentando selecionar Outro número Claro");

  await detectInitialRadioState(page);

  const result = await page.evaluate(() => {
    const findOutroNumeroBlockInPage = () => {
      const blocks = [...document.querySelectorAll("label, div, section, article")].filter(
        (el) => {
          const t = (el.innerText || "").trim();
          if (!/outro\s*n[uú]mero\s*claro/i.test(t)) return false;
          if (t.length > 600) return false;
          return true;
        }
      );
      if (!blocks.length) return null;

      return blocks.sort((a, b) => {
        const aRadio = a.querySelector('input[type="radio"]') ? 0 : 1;
        const bRadio = b.querySelector('input[type="radio"]') ? 0 : 1;
        if (aRadio !== bRadio) return aRadio - bRadio;
        return (a.innerText || "").length - (b.innerText || "").length;
      })[0];
    };

    const targetBlock = findOutroNumeroBlockInPage();

    if (!targetBlock) {
      return {
        ok: false,
        reason: "Container com texto Outro número Claro não encontrado"
      };
    }

    targetBlock.scrollIntoView({ block: "center", behavior: "instant" });

    const radio =
      targetBlock.querySelector('input[type="radio"]') ||
      targetBlock.closest("label")?.querySelector('input[type="radio"]');

    const clickable = radio || targetBlock;

    clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    clickable.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    if (typeof clickable.click === "function") {
      clickable.click();
    }

    if (radio && !radio.checked) {
      radio.checked = true;
      radio.dispatchEvent(new Event("input", { bubbles: true }));
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const checkedRadio = radio ? radio.checked : null;

    return {
      ok: checkedRadio === true,
      reason:
        checkedRadio === true
          ? "Outro número Claro marcado com sucesso (evaluate)"
          : "Clique executado, mas radio não ficou marcado (evaluate)",
      radioFound: !!radio,
      checkedRadio,
      text: (targetBlock.innerText || "").trim().slice(0, 200)
    };
  });

  console.log("[CLARO DEBUG] Resultado seleção (evaluate):", result);

  let status = await verifyOutroNumeroClaroActive(page);

  if (!status.ok) {
    console.log("[CLARO DEBUG] Tentando clique Playwright no radio/container...");
    const block = page
      .locator("label, div, section, article")
      .filter({ hasText: /outro\s*n[uú]mero\s*claro/i })
      .first();

    if ((await block.count()) > 0) {
      await block.scrollIntoViewIfNeeded();
      const radio = block.locator('input[type="radio"]').first();
      if ((await radio.count()) > 0) {
        await radio.click({ force: true, timeout: config.elementClickTimeoutMs });
      } else {
        await block.click({ force: true, timeout: config.elementClickTimeoutMs });
      }
      await sleep(500);
      status = await verifyOutroNumeroClaroActive(page);
    }
  }

  if (!status.ok) {
    await saveClaroRadioDebug(page, "fail");
    throw new Error(
      `[CLARO DEBUG] Falha ao marcar Outro número Claro: ${status.reason} | radios=${JSON.stringify(status.radios)}`
    );
  }

  return true;
};

const fillOutroNumeroClaroFields = async (page, digits) => {
  const dddField = page
    .locator('input[placeholder*="DDD + número Claro"], input[placeholder*="DDD + numero Claro"]')
    .first();

  if ((await dddField.count()) > 0) {
    await dddField.waitFor({ state: "visible", timeout: config.actionTimeoutMs });
    await dddField.fill("");
    await dddField.fill(digits);
    console.log("[CLARO DEBUG] Número preenchido no campo único DDD + número Claro");
    return true;
  }

  const filled = await fillFirstVisible(
    page,
    [
      'input[placeholder*="DDD + número"]',
      'input[placeholder*="DDD + numero"]',
      'input[placeholder*="DDD"]',
      'input[aria-label*="DDD" i]',
      'input[type="tel"]'
    ],
    digits,
    config.actionTimeoutMs
  );

  if (!filled) {
    throw new Error(
      "Campo DDD + número Claro não encontrado — opção Outro número pode não estar ativa."
    );
  }

  return true;
};

const runRechargeOtherNumberSteps = async (page, rechargeTargetNumber) => {
  const digits = normalizeBrMobile(rechargeTargetNumber);
  if (digits.length !== 11) {
    throw new Error("Número a recarregar inválido (use DDD + 9 dígitos).");
  }

  await dismissBonusModalIfVisible(page);
  await selecionarOutroNumeroClaro(page);

  const active = await verifyOutroNumeroClaroActive(page);
  if (!active.ok) {
    await saveClaroRadioDebug(page, "not_active_before_fill");
    throw new Error(
      `[CLARO DEBUG] Outro número Claro não está ativo antes do preenchimento: ${active.reason}`
    );
  }

  await fillOutroNumeroClaroFields(page, digits);
  await dismissBonusModalIfVisible(page);

  const okNick = await fillFirstVisible(
    page,
    [
      'input[placeholder*="apelido"]',
      'input[placeholder*="Apelido"]',
      'input[name*="apelido" i]',
      'input[name*="nickname" i]'
    ],
    config.defaultRechargeNickname,
    6000
  );
  if (!okNick) {
    console.warn("[claro] Campo apelido não encontrado; seguindo sem apelido.");
  }

  await clickContinuar(page, 6000).catch(() => {});
  await dismissBonusModalIfVisible(page);
};

const PHONE_LOGIN_SELECTORS = [
  'input[placeholder*="Digite seu nº claro"]',
  'input[placeholder*="Digite seu n"]',
  'input[placeholder*="nº claro"]',
  'input[placeholder*="número Claro"]',
  'input[placeholder*="numero Claro"]',
  'input[placeholder*="seu número"]',
  'input[placeholder*="seu numero"]',
  'input[name*="phone"]',
  'input[name*="msisdn"]',
  'input[type="tel"]'
];

const GERENCIAR_LABELS = [
  "Gerenciar recarga",
  "Gerenciar Recarga",
  "Gerencie sua recarga",
  "Gerenciar a recarga"
];

/** Campo de telefone do login já visível? */
const hasPhoneLoginField = async (page) => {
  // Caminho rápido: input tel da Claro.
  try {
    const tel = page.locator('input[type="tel"]').first();
    if ((await tel.count()) > 0 && (await tel.isVisible().catch(() => false))) return true;
  } catch {
    // fall through
  }
  for (const selector of PHONE_LOGIN_SELECTORS) {
    try {
      const loc = page.locator(selector).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        return true;
      }
    } catch {
      // next
    }
  }
  return false;
};

const tryOpenGerenciarRecarga = async (page, timeoutMs = 4000) => {
  if (await hasPhoneLoginField(page)) return true;
  if (await clickByText(page, GERENCIAR_LABELS, timeoutMs)) {
    await dismissCookieBanner(page);
    await sleep(300);
    return hasPhoneLoginField(page);
  }
  return false;
};

/** Espera o campo de telefone (só cookie + poll). Sem clicar Gerenciar a cada ciclo. */
const waitForPhoneLoginReady = async (page, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  let lastCookie = 0;
  while (Date.now() < deadline) {
    if (Date.now() - lastCookie > 700) {
      await dismissCookieBanner(page);
      lastCookie = Date.now();
    }
    if (await hasPhoneLoginField(page)) return true;
    // Aguarda o tel aparecer (SPA Claro ~2–5s após aceitar cookies).
    try {
      await page
        .locator('input[type="tel"]')
        .first()
        .waitFor({ state: "visible", timeout: 400 });
      return true;
    } catch {
      await sleep(150);
    }
  }
  return false;
};

const runBeforeCode = async (session, payload) => {
  const { page } = session;
  const accessNumber = normalizeBrMobile(
    payload.accessNumber || payload.claroNumber || session.accessNumber
  );

  // /login (ou /home→login) mostra o campo em ~4–5s. /landing é só marketing sem input.
  const loginUrl = config.landingUrl;

  setSessionStep(session, "open_site", "Abrindo login Claro (campo do número)…");
  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (err) {
    await saveStepDebug(page, "open_landing_fail");
    throw new Error(
      `Falha ao abrir site Claro (${loginUrl}): ${err?.message || err}. ` +
        "No PC novo confira internet, Edge instalado e se o site abre no navegador normal."
    );
  }

  setSessionStep(session, "landing", "Aguardando formulário do número…");
  await dismissCookieBanner(page);

  let readyForPhone = await waitForPhoneLoginReady(page, 10000);

  if (!readyForPhone) {
    setSessionStep(session, "open_home_retry", "Retry: home Claro (redireciona ao login)…");
    await page
      .goto(config.meusDadosUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000
      })
      .catch(() => {});
    await dismissCookieBanner(page);
    readyForPhone =
      (await waitForPhoneLoginReady(page, 8000)) || (await tryOpenGerenciarRecarga(page, 3000));
  }
  if (!readyForPhone) {
    await saveStepDebug(page, "gerenciar_recarga_fail");
    throw new Error(
      `Campo de telefone não encontrado. url=${page.url() || "?"}. ` +
        "Abra manualmente " + (config.landingUrl || "login Claro") + " neste PC " +
        "(Edge). Se a página não carregar, é rede/firewall — não é o número. " +
        "Screenshot em CLARO/debug/step_gerenciar_recarga_fail_*.png"
    );
  }

  setSessionStep(session, "fill_phone", `Preenchendo número de acesso ${accessNumber}…`);
  let okInputNumber = await fillFirstVisible(page, PHONE_LOGIN_SELECTORS, accessNumber, 6000);
  if (!okInputNumber) {
    await dismissCookieBanner(page);
    okInputNumber = await fillFirstVisible(page, PHONE_LOGIN_SELECTORS, accessNumber, 5000);
  }
  if (!okInputNumber) {
    await saveStepDebug(page, "fill_phone_fail");
    throw new Error(
      `Campo do número Claro (acesso / SMS) não encontrado. url=${page.url() || "?"}`
    );
  }
  session.accessNumber = accessNumber;
  await sleep(200);

  setSessionStep(session, "send_sms", "Enviando SMS (Continuar)…");
  const clickedSms = await clickContinuarWhenEnabled(page, 12000);
  if (!clickedSms) {
    throw new Error("Botão Continuar (envio SMS) não ficou habilitado — confira o número Claro.");
  }
  await dismissCookieBanner(page);
  setSessionStep(session, "waiting_sms", "Aguardando código SMS…");
};

/** Abre aba Dados / meus-dados para checar cartão (conta logada normal — não é cadastro excluído). */
const ensureDadosTabForCadastroCheck = async (session) => {
  const { page } = session;

  const onCardPath = async () =>
    (await visibleTextMatch(page, /Cadastrar\s+novo\s+cart/i)) ||
    (await visibleTextMatch(page, /Excluir\s+cart/i)) ||
    (await hasSavedCardOnDados(page));

  if (await onCardPath()) return true;

  if (isNlogPortal()) {
    const url = page.url() || "";
    if (!/\/meus-dados|criar-cartao/i.test(url)) {
      await page.goto(config.meusDadosUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await dismissCookieBanner(page);
      await sleep(800);
      if (await onCardPath()) return true;
    }
  }

  setSessionStep(session, "aba_dados", "Abrindo aba Dados (checagem de cadastro)…");

  const clickDadosTab = async () =>
    (await clickByText(page, ["Dados"], 8000)) ||
    (await page
      .getByRole("tab", { name: /^Dados$/i })
      .first()
      .click({ timeout: 5000 })
      .then(() => true)
      .catch(() => false));

  if (await clickDadosTab()) {
    await dismissCookieBanner(page);
    await delayStep(4);
    if (await onCardPath()) return true;
  }

  const url = page.url() || "";
  if (/gerenciar-programadas|programada/i.test(url)) {
    await clickByText(
      page,
      ["Outras Opções de Recarga", "Outras opções de recarga", "Outras opcoes de recarga"],
      8000
    ).catch(() => {});
    await sleep(700);
    if (await clickDadosTab()) {
      await delayStep(4);
      if (await onCardPath()) return true;
    }
  }

  if (m4uCustomerExists(session) || (await hasAuthenticatedUiMarkers(page))) {
    await refreshDadosTabAfterCardCleanup(page, session);
    if (await onCardPath()) return true;
    if (await clickDadosTab()) {
      await delayStep(4);
      return (await onCardPath()) || m4uCustomerExists(session);
    }
    return m4uCustomerExists(session);
  }

  return false;
};

const openDadosTabForCards = async (session) => {
  const { page } = session;

  if (session.cadastroVerificado) {
    await guardLandingInCardFlow(page, session, { debugStep: "sms_auth_fail_landing" });
    const onDadosUi =
      (await visibleTextMatch(page, /Cadastrar\s+novo\s+cart/i)) ||
      (await visibleTextMatch(page, /Excluir\s+cart/i));
    if (!onDadosUi) {
      await clickByText(page, ["Dados"], 8000);
      await delayStep(5);
    }
    return;
  }

  setSessionStep(session, "checar_cadastro", "Verificando cadastro Claro…");
  await session?.m4uAuthCapture?.waitForCustomerResult?.(10000);
  const cust = session?.m4uAuthCapture?.lastCustomer?.();
  if (cust && (cust.status === 404 || cust.status === 410)) {
    markAuthLost(session);
    throw claroFlowError(
      "cadastro_deletado",
      "Cliente não encontrado na Claro Recarga (cadastro excluído ou inexistente)."
    );
  }

  await guardLandingInCardFlow(page, session, { debugStep: "cadastro_landing_pos_sms" });

  const onCardUi =
    (await visibleTextMatch(page, /Cadastrar\s+novo\s+cart/i)) ||
    (await visibleTextMatch(page, /Excluir\s+cart/i)) ||
    (await visibleTextMatch(page, /Cadastrar\s+cart[aã]o\s+de\s+cr[eé]dito/i)) ||
    (await hasSavedCardOnDados(page));

  if (!onCardUi) {
    const openedDados = await ensureDadosTabForCadastroCheck(session);
    await dismissCookieBanner(page);
    await guardLandingInCardFlow(page, session, { debugStep: "cadastro_landing_pos_sms" });
    const onCardUiNow =
      (await visibleTextMatch(page, /Cadastrar\s+novo\s+cart/i)) ||
      (await visibleTextMatch(page, /Excluir\s+cart/i)) ||
      (await visibleTextMatch(page, /Cadastrar\s+cart[aã]o\s+de\s+cr[eé]dito/i)) ||
      (await hasSavedCardOnDados(page));
    if (!openedDados && !onCardUiNow) {
      if (m4uCustomerExists(session) || (await hasAuthenticatedUiMarkers(page))) {
        await saveStepDebug(page, "aba_dados_fail");
        throw claroFlowError(
          "erro_fluxo",
          "Conta logada na Claro, mas não foi possível abrir a área de cartão (Dados). Tente nova recarga."
        );
      }
      if (
        postSmsAuthOk(session) &&
        (isPostSmsLandingUrl(page) || (await isVisualLandingLogin(page)))
      ) {
        await throwCadastroDeletadoAfterSms(page, session, { debugStep: "cadastro_landing_pos_sms" });
      }
      await saveStepDebug(page, "cadastro_sem_aba_dados");
      throw claroFlowError(
        "cadastro_deletado",
        "Cadastro Claro Recarga indisponível — não foi possível abrir área de cartão."
      );
    }
  }

  session.cadastroVerificado = true;
};

const ensureAuthenticatedHome = async (session) => {
  const { page } = session;
  if (!sessionPageAlive(session)) {
    markAuthLost(session);
    throw new Error(
      "Navegador da sessão foi fechado. Retry sem SMS só funciona com a janela aberta — inicie de novo e envie SMS."
    );
  }

  const url = page.url() || "";
  const onErroOrFim = /pagamento-erro|confirmacao-beneficio|pagamento-sucesso|\/sucesso/i.test(url);
  const onLanding = await isBackOnLandingLogin(page, session);
  const alreadyAuthed = !onLanding && (await hasAuthenticatedUiMarkers(page));
  if (!onErroOrFim && !onLanding && alreadyAuthed) return;

  setSessionStep(session, "voltar_home", "Voltando à home autenticada (retry sem SMS)…");
  const homeUrl = isWebPortalSession(session)
    ? webPortalPath("home")
    : isNlogPortal()
      ? config.meusDadosUrl
      : config.baseUrl;
  await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await dismissCookieBanner(page);
  await sleep(1200);
  const ok = await waitForAuthenticatedUi(page, 10000, session);
  if (!ok) {
    await throwAuthFailure(page, session);
  }
};

/** PAN mascarado na aba Dados = cartão salvo (slot cheio — "Cadastrar novo" some). */
const hasSavedCardOnDados = async (page) => {
  return page.evaluate(() => {
    const t = (document.body?.innerText || "").replace(/\s+/g, " ");
    return (
      /\*{4}\s+\*{4}\s+\*{4}\s+\d{4}/.test(t) ||
      /•{4}\s+•{4}\s+•{4}\s+\d{4}/.test(t)
    );
  });
};

/** Verifica se "Cadastrar novo cartão" existe e se está clicável. */
const inspectNewCardOption = async (page) => {
  return page.evaluate(() => {
    const labels = [
      /cadastrar\s+novo\s+cart/i,
      /adicionar\s+cart/i,
      /^novo\s+cart/i
    ];
    const nodes = [
      ...document.querySelectorAll("button, a, [role='button'], label, div, span, p, li")
    ];
    let best = null;
    for (const el of nodes) {
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 80) continue;
      if (!labels.some((re) => re.test(text))) continue;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        continue;
      }
      const clickable =
        el.closest("button, a, [role='button'], label, [onclick], [tabindex]") || el;
      const ariaDisabled =
        String(clickable.getAttribute?.("aria-disabled") || "").toLowerCase() === "true" ||
        String(el.getAttribute?.("aria-disabled") || "").toLowerCase() === "true";
      const htmlDisabled = Boolean(clickable.disabled || el.disabled);
      const classDisabled = /disabled|is-disabled|btn--disabled|mdn-Button--disabled/i.test(
        `${clickable.className || ""} ${el.className || ""}`
      );
      const pointerNone = style.pointerEvents === "none";
      const enabled = !(ariaDisabled || htmlDisabled || classDisabled || pointerNone);
      const score = text.length;
      if (!best || score < best.score) {
        best = { text, enabled, score, ariaDisabled, htmlDisabled, classDisabled, pointerNone };
      }
    }
    if (!best) return { found: false, enabled: false, text: null };
    return {
      found: true,
      enabled: best.enabled,
      text: best.text,
      reason: best.enabled
        ? null
        : [
            best.htmlDisabled ? "disabled" : null,
            best.ariaDisabled ? "aria-disabled" : null,
            best.classDisabled ? "classe-disabled" : null,
            best.pointerNone ? "pointer-events:none" : null
          ]
            .filter(Boolean)
            .join(", ")
    };
  });
};

const NEW_CARD_LABELS = [
  "Cadastrar novo cartão",
  "Cadastrar novo cartao",
  "Adicionar cartão",
  "Adicionar cartao",
  "Novo cartão",
  "Novo cartao"
];

const assertNewCardOptionAvailable = async (page, session) => {
  const info = await inspectNewCardOption(page);
  if (info.found && !info.enabled) {
    const msg =
      `Opção "Cadastrar novo cartão" está DESABILITADA nesta linha/conta` +
      (info.reason ? ` (${info.reason})` : "") +
      ".";
    setSessionStep(session, "novo_cartao_desabilitado", msg);
    await saveStepDebug(page, "cadastrar_cartao_disabled");
    throw claroFlowError(
      "cadastro_deletado",
      `Opção "Cadastrar novo cartão" está DESABILITADA nesta linha/conta` +
        (info.reason ? ` (${info.reason})` : "") +
        " — cadastro Claro Recarga excluído ou indisponível."
    );
  }
  if (!info.found) {
    const msg =
      'Opção "Cadastrar novo cartão" indisponível (cadastro excluído ou conta sem permissão).';
    setSessionStep(session, "novo_cartao_desabilitado", msg);
    await saveStepDebug(page, "cadastrar_cartao_unavailable");
    throw claroFlowError("cadastro_deletado", msg);
  }
  return info;
};

/** Clica no botão de valor (whatsapp aba Recarga ou nlog /numero). */
const clickRechargeValueButton = async (page, session, rechargeValue) => {
  setSessionStep(session, "valor", `Selecionando valor R$ ${rechargeValue}…`);
  await dismissCookieBanner(page);
  const valRe = new RegExp(`R\\$\\s*${rechargeValue}\\b`);
  const candidates = [
    page.getByRole("button", { name: valRe }).first(),
    page.getByRole("radio", { name: valRe }).first(),
    page.locator("button, [role='button'], [role='radio'], label, a").filter({ hasText: valRe }).first(),
    page.getByText(valRe).first()
  ];
  for (const loc of candidates) {
    try {
      if ((await loc.count()) === 0) continue;
      await loc.waitFor({ state: "visible", timeout: 5000 });
      await loc.click({ timeout: config.actionTimeoutMs, force: true });
      await dismissBonusModalIfVisible(page);
      return;
    } catch {
      // tenta próximo seletor (web portal: R$ e valor em spans separados)
    }
  }
  const clicked = await page.evaluate((valor) => {
    const re = new RegExp(`R\\$\\s*${valor}\\b`);
    const nodes = [...document.querySelectorAll("button, [role='button'], [role='radio'], label, a, div, span")];
    const hits = nodes.filter((el) => {
      const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      return t.length < 80 && re.test(t);
    });
    const el = hits.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)[0];
    if (!el) return false;
    el.click();
    return true;
  }, rechargeValue);
  if (clicked) {
    await dismissBonusModalIfVisible(page);
    return;
  }
  const disponiveis = await page
    .evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("button, [role='button'], a, div, span")) {
        const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        const m = t.match(/R\$\s*(\d{1,4})(?:[.,]\d{2})?/);
        if (m && t.length < 40) out.push(`R$ ${m[1]}`);
      }
      return [...new Set(out)].slice(0, 15);
    })
    .catch(() => []);
  await saveStepDebug(page, "valor_indisponivel");
  const lista = disponiveis.length ? disponiveis.join(", ") : "nenhum na tela";
  throw claroFlowError(
    "valor_indisponivel",
    `Valor R$ ${rechargeValue} não disponível na Claro. Opções: ${lista}`
  );
};

/** Cadastro de cartão + pagamento (já autenticado por SMS) — whatsapp e nlog (mesmo fluxo, URLs do .env). */
const runCardAndPay = async (session, payload) => {
  if (isWebPortalSession(session)) {
    return runWebLinkRecharge(session, payload);
  }
  const { page } = session;
  const { rechargeValue } = payload;

  if (isNlogPortal()) {
    const url = page.url() || "";
    if (!/\/meus-dados|criar-cartao/i.test(url)) {
      setSessionStep(session, "meus_dados", "Abrindo Meus Dados…");
      await page.goto(meusDadosFor(session), { waitUntil: "domcontentloaded", timeout: 45000 });
      await dismissCookieBanner(page);
      await sleep(800);
    }
  }

  await openDadosTabForCards(session);
  session.useExistingSavedCard = false;
  await removeExistingCardsIfAny(page, session);

  setSessionStep(session, "novo_cartao", "Cadastrar novo cartão…");
  // Detecta desabilitado antes de ficar esperando o clique.
  let cardOpt = await inspectNewCardOption(page);
  // Lista vazia mas botão sumiu (bug UI Claro) — troca aba / reload como você fez manualmente.
  if (!cardOpt.found || !cardOpt.enabled) {
    await refreshDadosTabAfterCardCleanup(page, session);
    cardOpt = await inspectNewCardOption(page);
  }
  if (cardOpt.found && !cardOpt.enabled) {
    await assertNewCardOptionAvailable(page, session);
  }

  let openedNewCard = cardOpt.found && cardOpt.enabled
    ? await clickByText(page, NEW_CARD_LABELS, Math.max(config.actionTimeoutMs, 15000))
    : false;

  if (!openedNewCard) {
    // Slot cheio / botão sumiu — tenta limpar de novo, atualizar aba e clicar
    await removeExistingCardsIfAny(page, session);
    await refreshDadosTabAfterCardCleanup(page, session);
    cardOpt = await inspectNewCardOption(page);
    if (cardOpt.found && !cardOpt.enabled) {
      await assertNewCardOptionAvailable(page, session);
    }
    openedNewCard = await clickByText(page, NEW_CARD_LABELS, 12000);
  }
  if (!openedNewCard) {
    await assertNewCardOptionAvailable(page, session);
    // Se inspect achou enabled mas click falhou, ainda trata como indisponível.
    await saveStepDebug(page, "cadastrar_cartao_fail");
    throw new Error(
      'Opção "Cadastrar novo cartão" está DESABILITADA ou não responde ao clique nesta linha/conta.'
    );
  }
  await delayStep(9);

  setSessionStep(session, "cartao_credito", "Abrindo cadastro de cartão de crédito…");
  const onCriarCartao = /criar-cartao/i.test(page.url() || "");
  let panReady = onCriarCartao || (await isPanFormReady(page));
  if (!panReady) {
    if (!(await clickByText(page, ["Cadastrar cartão de crédito"]))) {
      panReady = await isPanFormReady(page);
      if (!panReady) {
        throw new Error("Tela Cadastrar cartão de crédito não encontrada.");
      }
    }
  }
  if (config.cardFormSettleMs > 0) {
    await sleep(config.cardFormSettleMs);
  }
  if (!(await isPanFormReady(page))) {
    await refreshCardFormViaTabs(page, session);
  }

  // Claim atômico só quando vai preencher o cartão (evita duas sessões com o mesmo PAM).
  setSessionStep(session, "claim_pam", "Reservando PAM do info.txt…");
  const pamRaw = reservePamForSession(session, payload);
  const pam = splitPamInfo(pamRaw);

  setSessionStep(session, "fill_pan", "Preenchendo dados do cartão (PAN / validade / CVV / nome)…");
  try {
    await fillCardFormDirectly(page, pam, session);
  } catch (err) {
    releaseUnusedPam(session);
    throw err;
  }
  await delayStep(10);

  setSessionStep(session, "salvar_cartao", "Salvando cartão…");
  if (!(await clickByText(page, ["Salvar cartão"]))) {
    throw new Error("Botão Salvar cartão não encontrado.");
  }
  await delayStep(11);

  setSessionStep(session, "cartao_ok", "Aguardando confirmação do cartão…");
  if (!(await waitForCardSaved(page))) {
    throw new Error("Confirmação de cartão cadastrado não apareceu.");
  }
  session.pamTouchCommitted = true;
  await goToFazerRecargaAfterCard(page, session);
  await delayStep(13);
  await dismissBonusModalIfVisible(page);

  const access = session.accessNumber || "";
  const target = session.rechargeTargetNumber || access;
  if (target && access && target !== access) {
    setSessionStep(session, "outro_numero", `Selecionando outro número para recarga ${target}…`);
    await runRechargeOtherNumberSteps(page, target);
    await delayStep(14);
    await delayStep(15);
    await delayStep(16);
  }

  await clickRechargeValueButton(page, session, rechargeValue);
  await delayStep(17);

  setSessionStep(session, "forma_pagamento", "Escolhendo Cartão de Crédito…");
  if (!(await clickByText(page, ["Cartão de Crédito", "Cartao de Credito"]))) {
    throw new Error("Forma de pagamento Cartão de Crédito não encontrada.");
  }
  await delayStep(18);
  // Claro às vezes demora a liberar o Recarregar / cobre com modal de bônus
  await sleep(800);
  await dismissBonusModalIfVisible(page).catch(() => {});

  if (isNlogPortal()) {
    const reachedPay = await page
      .waitForURL(/pagamento-cartao/i, { timeout: 35000, waitUntil: "domcontentloaded" })
      .then(() => true)
      .catch(() => false);
    if (!reachedPay && !/\/pagamento-cartao/i.test(page.url() || "")) {
      await saveStepDebug(page, "nlog_pagamento_cartao_timeout");
      throw new Error("Não redirecionou para /pagamento-cartao após escolher Cartão de Crédito.");
    }
    await dismissCookieBanner(page);
    await sleep(500);
  }

  setSessionStep(session, "recarregar", "Confirmando Recarregar…");
  if (!(await clickPrimeiroRecarregar(page))) {
    await saveStepDebug(page, "recarregar_primeiro_fail");
    throw new Error("Botão Recarregar (primeiro) não encontrado.");
  }
  await delayStep(19);

  setSessionStep(session, "cvv_final", "Preenchendo CVV final…");
  const okCvvInput = await fillFirstVisible(
    page,
    ['input[placeholder="CVV"]', 'input[maxlength="4"]'],
    config.defaultCvv
  );
  if (!okCvvInput) {
    throw new Error("Campo CVV final não encontrado.");
  }
  await delayStep(20);

  setSessionStep(session, "pagar", "Confirmando pagamento (Recarregar final)…");
  if (!(await clickFinalRecarregar(page))) {
    throw new Error("Botão Recarregar (final) não encontrado.");
  }
  await delayStep(21);

  setSessionStep(session, "aguardando_gate", "Aguardando retorno da gate / página de resultado…");
  const paymentResult = await waitForPaymentResult(page, 120000, session.gateCapture);
  await finalizePaymentResultSteps(session, paymentResult);
  return paymentResult;
};

/** cs / web-link: JWT loga → valor → pagamento-cartao → preenche cartão → Recarregar. */
const webNeedsOutroNumero = (session) => {
  const access = normalizeBrMobile(session?.accessNumber || session?.claroNumber || "");
  const target = normalizeBrMobile(session?.rechargeTargetNumber || access);
  return Boolean(access && target && target !== access);
};

const ensureWebRechargeReady = async (session) => {
  const { page } = session;
  await dismissCookieBanner(page);

  // A→B: landing marketing tem R$ mas não tem "Outro número" — outro helper navega.
  if (webNeedsOutroNumero(session)) return;

  if (await visibleTextMatch(page, /Escolha um valor de recarga/i)) return;

  const url = page.url() || "";
  const hasValueBtn = await page
    .evaluate(() => {
      for (const el of document.querySelectorAll("button, [role='button'], a")) {
        const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (/R\$\s*\d{1,4}/.test(t) && t.length < 40) return true;
      }
      return false;
    })
    .catch(() => false);
  if (hasValueBtn) return;

  if (await clickByText(page, ["Fazer recarga", "Fazer Recarga", "Recarregar"], 15000)) {
    await sleep(800);
    return;
  }

  if (!/\/numero|\/home/i.test(url)) {
    setSessionStep(session, "web_numero", "Abrindo tela de recarga…");
    await page.goto(webPortalPath("numero"), { waitUntil: "domcontentloaded", timeout: 45000 });
    await dismissCookieBanner(page);
    await sleep(800);
  }
};

const hasOutroNumeroClaroUi = async (page) =>
  page
    .evaluate(() => /outro\s*n[uú]mero\s*claro/i.test(document.body?.innerText || ""))
    .catch(() => false);

const hasEscolhaNumeroClaroUi = async (page) =>
  page
    .evaluate(() => /escolha um n[uú]mero claro/i.test(document.body?.innerText || ""))
    .catch(() => false);

const isWebLandingMarketing = async (page) => {
  const u = page.url() || "";
  if (/\/landing/i.test(u)) return true;
  return page
    .evaluate(
      () =>
        /Recarregue e ganhe b[oô]nus/i.test(document.body?.innerText || "") &&
        !/escolha um n[uú]mero claro/i.test(document.body?.innerText || "")
    )
    .catch(() => false);
};

/** Landing JWT: Recarregar da seção celular (evita botões Claro TV). */
const clickLandingMobileRecargaEntry = async (page) => {
  const clicked = await page.evaluate(() => {
    const inTvBlock = (el) => {
      let n = el;
      for (let i = 0; i < 14 && n; i++) {
        if (/Claro TV/i.test((n.innerText || "").slice(0, 500))) return true;
        n = n.parentElement;
      }
      return false;
    };
    const nodes = [...document.querySelectorAll("button, [role='button'], a")];
    for (const el of nodes) {
      const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!/Recarregar/i.test(t)) continue;
      if (inTvBlock(el)) continue;
      const ctx = (el.closest("section, article, div")?.innerText || "").slice(0, 600);
      if (/Escolha o valor|b[oô]nus exclusivos|R\$\s*\d+/i.test(ctx)) {
        el.click();
        return "mobile_recarga";
      }
    }
    for (const el of nodes) {
      const t = (el.innerText || "").trim();
      if (/^Recarregar$/i.test(t) && !inTvBlock(el)) {
        el.click();
        return "recarregar_fallback";
      }
    }
    return null;
  });
  if (clicked) {
    console.log(`[claro] landing → fluxo recarga (${clicked})`);
    await sleep(1500);
  }
  return Boolean(clicked);
};

const pushWebPortalRoute = async (page, suffix) => {
  const path = `/minhaclaro_web/${String(suffix || "").replace(/^\//, "")}`;
  await page.evaluate((p) => {
    if (window.location.pathname !== p) {
      window.history.pushState({}, "", p);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, path);
  await sleep(2000);
};

/** Web-link A→B: sai do landing marketing até aparecer Outro número Claro. */
const ensureWebNumeroChoiceScreen = async (session) => {
  const { page } = session;
  await dismissCookieBanner(page);
  await dismissBonusModalIfVisible(page);

  const ready = async () =>
    (await hasOutroNumeroClaroUi(page)) || (await hasEscolhaNumeroClaroUi(page));

  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    if (await ready()) return true;

    if (await isWebLandingMarketing(page)) {
      setSessionStep(session, "web_numero", "Entrando no fluxo celular (saindo do landing)…");
      if (await clickLandingMobileRecargaEntry(page)) continue;
    }

    const url = page.url() || "";
    if (!/\/numero/i.test(url) || !(await ready())) {
      setSessionStep(session, "web_numero", "Abrindo Escolha um número Claro…");
      if (!(await clickByText(page, ["Fazer recarga", "Fazer Recarga"], 6000))) {
        await page
          .goto(webPortalPath("numero"), { waitUntil: "domcontentloaded", timeout: 45000 })
          .catch(() => {});
      }
      await dismissCookieBanner(page);
      await sleep(1200);

      if (!(await ready()) && (await isWebLandingMarketing(page))) {
        await clickLandingMobileRecargaEntry(page);
        await sleep(1200);
      }
      if (!(await ready())) {
        await pushWebPortalRoute(page, "numero");
      }
      continue;
    }

    if (
      await clickByText(
        page,
        ["Outras Opções de Recarga", "Outras opções de recarga", "Outras opcoes de recarga", "Ver mais valores"],
        5000
      )
    ) {
      await sleep(700);
      continue;
    }

    await sleep(400);
  }

  return ready();
};

const hasSmartCheckout = async (page, session = null) => {
  const pageUrl = page.url() || "";
  // Doc §9: rota /:channel/smartcheckout
  if (/\/smartcheckout/i.test(pageUrl)) return true;
  if (
    (await locatorCountSafe(
      page.locator(
        'iframe#checkout, iframe[title="smartCheckout"], iframe[src*="smart-checkout"], iframe[src*="eldorado"]'
      ),
      1500
    )) > 0
  ) {
    return true;
  }
  // Doc §7: iframe Eldorado BSC + Bemobi session
  if (
    page.frames().some((f) => {
      const u = f.url() || "";
      return (
        /eldorado\.m4u\.com\.br\/bsc\/checkout/i.test(u) || /smart-checkout\.bemobi\.com/i.test(u)
      );
    })
  ) {
    return true;
  }
  // Doc §13 passos 1–2: API confirmou checkout — não bloquear em locator.count()
  if (session?.checkoutApiOk && session.checkoutApiOkAt) {
    const elapsed = Date.now() - session.checkoutApiOkAt;
    if (elapsed >= 1200) {
      if (session.bemobiSessionOk) return true;
      if (/\/smartcheckout/i.test(pageUrl)) return true;
      if (
        page.frames().some((f) =>
          /smart-checkout\.bemobi|eldorado\.m4u\.com\.br\/bsc\/checkout/i.test(f.url() || "")
        )
      ) {
        return true;
      }
      if (elapsed >= 2500) return true;
    }
  }
  return false;
};

const waitForSmartCheckout = async (page, timeoutMs = 15000, session = null) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasSmartCheckout(page, session)) return true;
    await sleep(350);
  }
  return false;
};

/** Inspect / fill: checkout monta após valor — fecha modal bônus e espera iframe Eldorado. */
const ensureSmartCheckoutReady = async (page, session) => {
  await dismissCookieBanner(page);
  await dismissBonusModalIfVisible(page);
  const iframe = page.locator('iframe#checkout, iframe[title="smartCheckout"]').first();
  if ((await iframe.count()) > 0) {
    await iframe.scrollIntoViewIfNeeded().catch(() => {});
  }
  if (await hasSmartCheckout(page, session)) {
    await ensureCardCheckoutOrThrow(page, session);
    await prepareEldoradoCheckoutForm(page);
    await waitForEldoradoCheckoutReady(page, 30000);
    await ensureCardCheckoutOrThrow(page, session);
    return true;
  }
  setSessionStep(session, "smart_checkout", "Aguardando checkout abrir…");
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await dismissBonusModalIfVisible(page);
    if (await hasSmartCheckout(page, session)) {
      await ensureCardCheckoutOrThrow(page, session);
      await prepareEldoradoCheckoutForm(page);
      await waitForEldoradoCheckoutReady(page, 25000);
      await ensureCardCheckoutOrThrow(page, session);
      return true;
    }
    if (await detectPixOnlyCheckout(page, session)) {
      await saveStepDebug(page, "valor_pix_only_gate");
      throw claroFlowError("valor_indisponivel", "Valor não disponível nesse número (cartão indisponível nesta linha).");
    }
    await sleep(400);
  }
  await throwIfPixOnlyCheckout(page, session);
  return false;
};

const checkoutTextBlob = async (page) => {
  const parts = [];
  try {
    parts.push(await page.locator("body").innerText({ timeout: 2000 }));
  } catch {
    // ignore
  }
  for (const frame of page.frames()) {
    try {
      parts.push(await frame.evaluate(() => document.body?.innerText || ""));
    } catch {
      // ignore
    }
  }
  return parts.join(" ").replace(/\s+/g, " ");
};

const checkoutTextBlobEldorado = async (page) => {
  const parts = [];
  for (const frame of page.frames()) {
    const u = frame.url() || "";
    if (!isEldoradoCheckoutUrl(u) && !/eldorado\.m4u\.com\.br\/bsc\/checkout/i.test(u)) continue;
    try {
      parts.push(await frame.evaluate(() => document.body?.innerText || ""));
    } catch {
      // ignore
    }
  }
  return parts.join(" ").replace(/\s+/g, " ");
};

const gateBodyPixOnly = (body) => {
  if (!body || typeof body !== "object") return false;
  const allowed = body.paymentMethodsAllowed;
  if (Array.isArray(allowed) && allowed.length) {
    const hasCredit = allowed.includes("credit") || allowed.includes("debit");
    if (hasCredit) return false;
    if (allowed.includes("pix")) return true;
  }
  const pl = body.metadata?.features?.paymentsList;
  if (Array.isArray(pl)) {
    const credit = pl.find((x) => x?.name === "credit");
    if (credit && credit.active === false) return true;
  }
  return false;
};

const gateBodyHasCredit = (body) => {
  if (!body || typeof body !== "object") return false;
  const allowed = body.paymentMethodsAllowed;
  if (Array.isArray(allowed) && allowed.length) {
    return allowed.includes("credit") || allowed.includes("debit");
  }
  return false;
};

const gateCaptureHasCredit = (gateCapture) => {
  const caps = gateCapture?.captures || [];
  for (let i = caps.length - 1; i >= 0; i -= 1) {
    const c = caps[i];
    if (!/\/api-bsc\/api\/v1\/session/i.test(String(c.url || ""))) continue;
    if (gateBodyHasCredit(c.body)) return true;
  }
  return false;
};

const gateCapturePixOnly = (gateCapture) => {
  const caps = gateCapture?.captures || [];
  for (let i = caps.length - 1; i >= 0; i -= 1) {
    const c = caps[i];
    const u = String(c.url || "");
    if (!/\/api-bsc\/api\/v1\/session/i.test(u)) continue;
    if (gateBodyPixOnly(c.body)) return true;
  }
  return false;
};

/** Checkout sem opção de cartão de crédito (só Pix / Apple Pay / NuPay). */
const isCardPaymentUnavailable = (text) => {
  const t = String(text || "");
  const pix = /\bpix\b/i.test(t);
  const cardPath =
    /cart[aã]o\s+cr[eé]dito|novo\s+cr[eé]dito|cr[eé]dito\s+final|n[uú]mero do cart[aã]o|pagamento-cartao/i.test(t);
  if (pix && !cardPath) return true;
  if (/escolha como pagar/i.test(t) && !cardPath) return true;
  return false;
};

const isPixOnlyAfterValor = (text) => isCardPaymentUnavailable(text);

const gateCaptureSmartCheckoutBlock = (gateCapture) => {
  const caps = gateCapture?.captures || [];
  for (let i = caps.length - 1; i >= 0; i -= 1) {
    const c = caps[i];
    const u = String(c.url || "");
    if (!/smartcheckout\/v2\/url/i.test(u)) continue;
    if (c.httpStatus === 429) return { httpStatus: 429, code: "rate_limit" };
    if (c.httpStatus >= 400) return { httpStatus: c.httpStatus, code: "checkout_api_error" };
  }
  return null;
};

const throwIfCheckoutApiBlocked = (session) => {
  const block =
    session?.checkoutApiError || gateCaptureSmartCheckoutBlock(session?.gateCapture);
  if (!block) return;
  if (block.code === "rate_limit" || block.httpStatus === 429) {
    throw claroFlowError(
      "rate_limit",
      "Muitas tentativas na Claro (429). Aguarde 15–30 minutos e tente novamente."
    );
  }
  throw claroFlowError(
    "checkout_api_error",
    `Checkout indisponível (HTTP ${block.httpStatus}). Tente novamente em alguns minutos.`
  );
};

const detectPixOnlyCheckout = async (page, session) => {
  if (gateCaptureHasCredit(session?.gateCapture)) return false;
  if (gateCapturePixOnly(session?.gateCapture)) return true;
  // Texto só após iframe Eldorado montar — evita falso "só Pix" enquanto carrega cartão.
  if (!(await hasSmartCheckout(page, session))) return false;
  const payText = await checkoutTextBlobEldorado(page);
  if (!String(payText || "").trim()) return false;
  return isCardPaymentUnavailable(payText);
};

const throwIfPixOnlyCheckout = async (page, session = null) => {
  if (!(await detectPixOnlyCheckout(page, session))) return false;
  await saveStepDebug(page, gateCapturePixOnly(session?.gateCapture) ? "valor_pix_only_gate" : "valor_pix_only");
  throw claroFlowError("valor_indisponivel", "Valor não disponível nesse número (cartão indisponível nesta linha).");
};

const ensureCardCheckoutOrThrow = async (page, session = null) => {
  await throwIfPixOnlyCheckout(page, session);
};

const CHECKOUT_NEW_CARD_LABELS = [
  "Novo crédito",
  "Novo credito",
  "Novo cartão",
  "Novo cartao",
  "Novo cartão de crédito",
  "Novo cartao de credito",
  "Cadastrar um novo cartão",
  "Cadastrar um novo cartao",
  "Usar outro cartão",
  "Usar outro cartao",
  "Outro cartão",
  "Outro cartao",
  "Adicionar cartão",
  "Adicionar cartao",
  "Incluir cartão",
  "Incluir cartao",
  "Pagar com outro cartão",
  "Cadastrar novo cartão",
  "Cadastrar novo cartao",
  "Cadastrar cartão de crédito",
  "Cadastrar cartao de credito"
];

const eldoradoCheckoutFrames = (page) =>
  page.frames().filter((f) => isEldoradoCheckoutUrl(f.url()) || /eldorado\.m4u\.com\.br/i.test(f.url() || ""));

/** Clica o tile "Novo Crédito" (carrossel) — não o bloco pai "Escolha como pagar". */
const clickCheckoutNewCard = async (page) => {
  for (const frame of eldoradoCheckoutFrames(page)) {
    try {
      await frame.evaluate(() => {
        const row = [...document.querySelectorAll("div")].find((el) =>
          /cr[eé]dito\s+final\s+\d{4}/i.test(el.innerText || "")
        );
        if (row) row.scrollLeft = row.scrollWidth;
      });
    } catch {
      // ignore
    }
    try {
      const hit = await frame.evaluate(() => {
        let best = null;
        let bestArea = Infinity;
        for (const el of document.querySelectorAll("*")) {
          const t = (el.innerText || "").replace(/\s+/g, " ").trim();
          if (!/^novo\s+cr[eé]dito$/i.test(t) && !/^novo\s+cart[aã]o$/i.test(t)) continue;
          const r = el.getBoundingClientRect();
          const area = r.width * r.height;
          if (r.width < 20 || r.height < 20 || area > 50000) continue;
          if (area < bestArea) {
            best = el;
            bestArea = area;
          }
        }
        if (!best) return null;
        best.scrollIntoView({ block: "nearest", inline: "center" });
        best.click();
        return (best.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40);
      });
      if (hit) {
        console.log(`[claro] checkout: clicou tile "${hit}"`);
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
};

const hasSavedCardInCheckout = async (page) => {
  for (const frame of page.frames()) {
    try {
      const hit = await frame.evaluate(() => {
        const t = (document.body?.innerText || "").replace(/\s+/g, " ");
        return (
          /cr[eé]dito\s+final\s+\d{4}/i.test(t) ||
          /\bfinal\s+\d{4}\b/i.test(t) ||
          /\*{4}\s*\*{4}\s*\*{4}\s*\d{4}/.test(t) ||
          /•{4}\s*•{4}\s*•{4}\s*\d{4}/.test(t) ||
          /cart[aã]o\s+(cadastrado|salvo)/i.test(t)
        );
      });
      if (hit) return true;
    } catch {
      // ignore
    }
  }
  try {
    return await page.evaluate(() => {
      const t = (document.body?.innerText || "").replace(/\s+/g, " ");
      return /cr[eé]dito\s+final\s+\d{4}/i.test(t) || /\*{4}\s*\*{4}/.test(t);
    });
  } catch {
    return false;
  }
};

const checkoutHasToastExcluido = async (page) => {
  for (const frame of eldoradoCheckoutFrames(page)) {
    try {
      const hit = await frame.getByText(/Cart[aã]o exclu[ií]do com sucesso/i).count();
      if (hit > 0) return true;
    } catch {
      // ignore
    }
  }
  return false;
};

const clickEldoradoCardMenu = async (page, frame) => {
  try {
    const card = frame.getByText(/(?:cr[eé]dito\s+)?final\s+\d{4}/i).first();
    if ((await card.count()) === 0) return null;
    const label = ((await card.innerText()) || "").replace(/\s+/g, " ").trim().slice(0, 40);
    const pt = await card.evaluate((el) => {
      let root = el;
      for (let up = 0; up < 10 && root.parentElement; up += 1) {
        const r = root.getBoundingClientRect();
        if (r.width >= 70 && r.width <= 320 && r.height >= 48 && r.height <= 260) break;
        root = root.parentElement;
      }
      const r = root.getBoundingClientRect();
      return { x: r.right - 12, y: r.top + 12 };
    });
    const iframe = page.locator('iframe#checkout, iframe[title="smartCheckout"]').first();
    const iframeBox = await iframe.boundingBox().catch(() => null);
    if (!iframeBox) return null;
    await page.mouse.click(iframeBox.x + pt.x, iframeBox.y + pt.y);
    return label;
  } catch {
    return null;
  }
};

/** ⋮ no canto do tile → Excluir → Sim → toast. No máximo 3 cartões. */
const removeSavedCardsInCheckout = async (page) => {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !(await hasSavedCardInCheckout(page))) {
    await sleep(400);
  }
  let removed = 0;
  for (let i = 0; i < 3; i += 1) {
    if (!(await hasSavedCardInCheckout(page))) break;
    let opened = false;
    for (const frame of eldoradoCheckoutFrames(page)) {
      const hit = await clickEldoradoCardMenu(page, frame);
      if (!hit) continue;
      opened = true;
      console.log(`[claro] checkout: ⋮ em "${hit}"`);
      break;
    }
    if (!opened) break;
    await sleep(500);
    const pickedDelete =
      (await clickInAnyFrame(
        page,
        ["Excluir cartão", "Excluir cartao", "Remover cartão", "Remover cartao", "Excluir", "Remover"],
        2500
      )) || false;
    if (pickedDelete) await sleep(400);
    const confirmed =
      (await clickInAnyFrame(page, ["Sim", "Confirmar", "Excluir", "Remover"], 3500)) || false;
    if (!confirmed && !pickedDelete) {
      console.warn("[claro] checkout: ⋮ aberto mas sem Excluir/Sim");
      break;
    }
    const toastAt = Date.now();
    let ok = false;
    while (Date.now() - toastAt < 8000) {
      if (await checkoutHasToastExcluido(page)) {
        ok = true;
        break;
      }
      if (!(await hasSavedCardInCheckout(page))) {
        ok = true;
        break;
      }
      await sleep(300);
    }
    if (!ok) {
      console.warn("[claro] checkout: confirmou mas sem exclusão");
      break;
    }
    removed += 1;
    await sleep(800);
  }
  if (removed) console.log(`[claro] checkout: apagou ${removed} cartão(ões) salvo(s)`);
  return removed;
};

const clickInAnyFrame = async (page, labels, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  const list = Array.isArray(labels) ? labels : [labels];
  while (Date.now() < deadline) {
    if (await clickByText(page, list, 800)) return true;
    for (const frame of page.frames()) {
      for (const label of list) {
        try {
          const re = new RegExp(label, "i");
          const candidates = [
            frame.getByRole("button", { name: re }).first(),
            frame.locator("button, [role='button'], input[type='submit'], a").filter({ hasText: re }).first(),
            frame.getByText(re).first()
          ];
          for (const btn of candidates) {
            if ((await btn.count()) === 0) continue;
            if (!(await btn.isVisible().catch(() => false))) continue;
            await btn.click({ timeout: 2500 });
            return true;
          }
        } catch {
          // iframe cross-origin ou botão indisponível
        }
      }
    }
    await sleep(350);
  }
  return false;
};

/** Smart Checkout / pagamento-cartao: se já tem cartão salvo, abre "Novo cartão" antes do PAN. */
const ensureCheckoutNewCardForm = async (page, session) => {
  if (await isPanFormReady(page)) return true;

  setSessionStep(session, "checkout_novo_cartao", "Selecionando novo cartão no checkout…");
  await prepareEldoradoCheckoutForm(page);
  const deadline = Date.now() + 28000;
  let attempts = 0;

  while (Date.now() < deadline && attempts < 8) {
    if (await isPanFormReady(page)) return true;

    const saved = await hasSavedCardInCheckout(page);
    if (saved || attempts === 0) {
      attempts += 1;
      if (saved) {
        await removeSavedCardsInCheckout(page);
        await sleep(600);
      }
      if (await clickCheckoutNewCard(page)) {
        await sleep(config.cardFormSettleMs > 0 ? config.cardFormSettleMs : 1500);
        await captureWebLinkStep(page, "after_novo_credito", session);
        if (await isPanFormReady(page)) return true;
      } else if (attempts <= 2) {
        await clickInAnyFrame(page, CHECKOUT_NEW_CARD_LABELS.slice(0, 6), 2000);
        await sleep(900);
      }
    } else {
      await sleep(600);
    }
  }

  if (!(await isPanFormReady(page))) {
    await captureWebLinkStep(page, "checkout_novo_cartao_fail", session);
    await throwIfPixOnlyCheckout(page, session);
  }
  return isPanFormReady(page);
};

const finalizePaymentResultSteps = async (session, paymentResult) => {
  if (paymentResult?.status === "success") {
    setSessionStep(session, "sucesso", "Pagamento confirmado com sucesso");
    session.needsPosSucessoCleanup = true;
  } else if (paymentResult?.status === "3ds_blocked") {
    setSessionStep(
      session,
      "3ds_blocked",
      paymentResult.message || "3DS detectado — sessão encerrada"
    );
    console.log(`[claro][3ds] fechando sessão ${session.id}`);
    try {
      await closeSession(session.id);
    } catch {
      /* ignore */
    }
  } else if (paymentResult?.status === "error") {
    setSessionStep(
      session,
      "erro_gate",
      paymentResult.gateMessage || paymentResult.message || "Pagamento recusado"
    );
    if (isNegativeListGate(paymentResult)) {
      await excluirCadastroClaroPosListaNegativa(session);
    }
  } else {
    setSessionStep(session, "timeout", paymentResult?.message || "Timeout no pagamento");
  }
  return paymentResult;
};

const runWebLinkCheckoutPayAttempt = async (session, payload) => {
  const { page } = session;

  if (config.apiPayPocEnabled && !payload?.inspect && !session.inspect) {
    setSessionStep(
      session,
      "api_pay_poc",
      "Tentando pagamento via API (PoC)…"
    );
    let pamForPoc = String(payload?.pamInfo ?? "").trim();
    if (!pamForPoc || !pamForPoc.includes("|")) {
      pamForPoc = reservePamForSession(session, payload);
    }
    const pocResult = await tryApiDirectEldoradoPay(session, payload, pamForPoc).catch((err) => {
      console.log(`[claro][api-pay-poc] exceção: ${err?.message || err} — fallback browser`);
      return null;
    });
    if (pocResult?.status === "success") {
      session.pamTouchCommitted = true;
      setSessionStep(session, "sucesso", "Pagamento confirmado com sucesso (API PoC)");
      session.needsPosSucessoCleanup = false;
      await captureWebLinkStep(page, "gate_success_api_poc", session);
      await persistGateDebug(session.gateCapture?.best?.(), "success", session.gateCapture);
      return pocResult;
    }
    if (pocResult?.status === "error") {
      session.pamTouchCommitted = true;
      setSessionStep(
        session,
        "erro_gate",
        pocResult.gateMessage || pocResult.message || "Pagamento recusado"
      );
      await captureWebLinkStep(page, "gate_error_api_poc", session);
      await persistGateDebug(session.gateCapture?.best?.(), "error", session.gateCapture);
      if (isNegativeListGate(pocResult)) {
        await excluirCadastroClaroPosListaNegativa(session);
      }
      return pocResult;
    }
    console.log("[claro][api-pay-poc] fallback para checkout browser");
  }

  await fillWebLinkCardDirect(session, payload);
  await delayStep(19);
  await captureWebLinkStep(page, "after_fill_card", session);

  setSessionStep(session, "pagar", "Confirmando pagamento…");
  let payOk = await clickEldoradoPayButton(page, 12000);
  if (!payOk) {
    payOk = await clickInAnyFrame(page, [
      "Pagar R$",
      "Pagar",
      "Pagar agora",
      "Confirmar pagamento",
      "Confirmar",
      "Finalizar",
      "Finalizar pagamento",
      "Recarregar",
      "Continuar"
    ], 30000);
  }
  if (!payOk) {
    await saveStepDebug(page, "smart_checkout_pagar_fail");
    throw new Error("Botão de confirmar pagamento no checkout não encontrado.");
  }
  await delayStep(21);
  await captureWebLinkStep(page, "after_pay_click", session);

  setSessionStep(session, "aguardando_gate", "Aguardando retorno da gate…");
  const paymentResult = await waitForPaymentResult(
    page,
    config.paymentWaitTimeoutMs || 120000,
    session.gateCapture
  );
  await captureWebLinkStep(page, `gate_${paymentResult?.status || "unknown"}`, session);
  await finalizePaymentResultSteps(session, paymentResult);
  return paymentResult;
};

const runWebLinkSmartCheckout = async (session, payload) => {
  const { page } = session;
  setSessionStep(session, "smart_checkout", "Checkout M4U — pagamento direto…");
  captureStuckSnapshot(session, "smart_checkout_entrada").catch(() => {});
  await dismissCookieBanner(page);
  await page.locator('iframe#checkout, iframe[title="smartCheckout"]').first()
    .waitFor({ state: "attached", timeout: 30000 })
    .catch(() => {});
  const eldoradoFrame = await waitForEldoradoCheckoutReady(page, 45000);
  if (!eldoradoFrame) {
    await captureStuckSnapshot(session, "eldorado_timeout");
  }
  await sleep(1200);
  await captureWebLinkStep(page, "smart_checkout_open", session);
  await ensureCardCheckoutOrThrow(page, session);

  if (payload?.inspect || session.inspect) {
    await persistGateDebug(session.gateCapture?.best?.(), "inspect", session.gateCapture);
    session.status = "inspect";
    session.inspect = true;
    setSessionStep(session, "inspect", "Checkout aberto — aguardando alinhamento (sem preencher).");
    console.log("[claro] INSPECT: checkout aberto, browser fica aberto. Não preenche cartão.");
    return {
      status: "inspect",
      sessionId: session.id,
      url: page.url(),
      captures: session.gateCapture?.captures?.length || 0,
      browserLeftOpen: true
    };
  }

  return runWebLinkCheckoutPayAttempt(session, payload);
};

/** Preenche PAN/CVV no checkout — sem cadastrar/salvar cartão na conta. */
const fillWebLinkCardDirect = async (session, payload) => {
  const { page } = session;
  setSessionStep(session, "claim_pam", "Preenchendo cartão (pagamento direto)…");
  const pamRaw = reservePamForSession(session, payload);
  const pam = splitPamInfo(pamRaw);

  setSessionStep(session, "fill_pan", "Aguardando checkout Eldorado…");
  await dismissCookieBanner(page);
  if (!(await ensureSmartCheckoutReady(page, session))) {
    if (gateCaptureHasCredit(session?.gateCapture)) {
      throw new Error(
        "Checkout Eldorado não carregou a tempo (cartão disponível — campo PAN demorou)."
      );
    }
    throw claroFlowError(
      "valor_indisponivel",
      "Valor não disponível nesse número (checkout sem cartão de crédito)."
    );
  }
  await ensureCardCheckoutOrThrow(page, session);
  await captureWebLinkStep(page, "before_novo_credito", session);
  await prepareEldoradoCheckoutForm(page);

  const eldoradoFrame = await waitForEldoradoCheckoutReady(page, 15000);
  if (eldoradoFrame) {
    setSessionStep(session, "fill_pan", "PAN / validade / CVV / nome (Eldorado)…");
    try {
      await fillEldoradoBscCheckout(page, pam, session);
      session.pamTouchCommitted = true;
      return;
    } catch (err) {
      await persistGateDebug(session.gateCapture?.best?.(), "fill_fail", session.gateCapture);
      await captureWebLinkStep(page, "smart_checkout_fill_fail", session);
      releaseUnusedPam(session);
      try {
        await throwIfPixOnlyCheckout(page, session);
      } catch (pixErr) {
        throw pixErr;
      }
      throw err;
    }
  }

  await prepareEldoradoCheckoutForm(page);
  await ensureCheckoutNewCardForm(page, session);
  await prepareEldoradoCheckoutForm(page);

  const panDeadline =
    Date.now() + Math.max(config.cardFormReadyTimeoutMs, config.cardIframeTimeoutMs, 45000);
  while (Date.now() < panDeadline) {
    if (await isPanFormReady(page)) break;
    if (await hasSavedCardInCheckout(page)) {
      await ensureCheckoutNewCardForm(page, session);
    }
    await sleep(400);
  }

  setSessionStep(session, "fill_pan", "PAN / validade / CVV / nome…");
  try {
    await fillCardFormDirectly(page, pam, session);
    session.pamTouchCommitted = true;
  } catch (err) {
    await captureWebLinkStep(page, "smart_checkout_fill_fail", session);
    releaseUnusedPam(session);
    try {
      await throwIfPixOnlyCheckout(page, session);
    } catch (pixErr) {
      throw pixErr;
    }
    throw err;
  }
};

const runWebLinkRecharge = async (session, payload) => {
  const { page } = session;
  const { rechargeValue } = payload;

  await ensureWebRechargeReady(session);
  await dismissBonusModalIfVisible(page);

  const access = session.accessNumber || "";
  const target = session.rechargeTargetNumber || access;
  if (target && access && target !== access) {
    if (!(await ensureWebNumeroChoiceScreen(session))) {
      await saveClaroRadioDebug(page, "no_numero_screen");
      throw claroFlowError(
        "erro_fluxo",
        "Tela Outro número Claro não carregou (/minhaclaro_web/numero)."
      );
    }
    setSessionStep(session, "outro_numero", `Selecionando outro número para recarga ${target}…`);
    await runRechargeOtherNumberSteps(page, target);
    await delayStep(14);
  }

  await clickRechargeValueButton(page, session, rechargeValue);
  setSessionStep(session, "aguardando_checkout", "Aguardando Smart Checkout abrir…");

  await delayStep(17);
  await dismissBonusModalIfVisible(page).catch(() => {});
  await sleep(800);
  captureWebLinkStep(page, "after_valor", session).catch(() => {});

  const checkoutDeadline = Date.now() + 35000;
  while (Date.now() < checkoutDeadline) {
    throwIfCheckoutApiBlocked(session);
    if (await hasSmartCheckout(page, session)) break;
    if (await detectPixOnlyCheckout(page, session)) {
      await saveStepDebug(page, "valor_pix_only_gate");
      throw claroFlowError("valor_indisponivel", "Valor não disponível nesse número (cartão indisponível nesta linha).");
    }
    await sleep(400);
  }
  throwIfCheckoutApiBlocked(session);
  if (!(await hasSmartCheckout(page, session)) && !(await waitForSmartCheckout(page, 12000, session))) {
    throwIfCheckoutApiBlocked(session);
    if (!gateCaptureHasCredit(session?.gateCapture) && (await detectPixOnlyCheckout(page, session))) {
      throw claroFlowError("valor_indisponivel", "Valor não disponível nesse número (cartão indisponível nesta linha).");
    }
  }
  await throwIfPixOnlyCheckout(page, session);

  const hasCheckout = await hasSmartCheckout(page, session);
  if (hasCheckout) {
    captureStuckSnapshot(session, "checkout_aberto").catch(() => {});
    return runWebLinkSmartCheckout(session, payload);
  }

  throwIfCheckoutApiBlocked(session);
  await saveStepDebug(page, "valor_sem_cartao");
  throw claroFlowError("valor_indisponivel", "Valor não disponível nesse número.");
};

const runWebLinkRechargeWithRetry = async (session, payload) => runWebLinkRecharge(session, payload);

const runAfterCode = async (session, payload) => {
  const { page } = session;
  const { clientCode } = payload;

  if (!session.gateCapture && session.context) {
    attachClaroNetworkHooks(session.context, session);
  }

  if (!session.smsAuthenticated) {
    setSessionStep(session, "fill_sms", "Preenchendo código SMS…");
    const codeSelectors = [
      'input[placeholder*="Digite o código"]',
      'input[placeholder*="Digite o codigo"]',
      'input[placeholder*="código"]',
      'input[placeholder*="codigo"]',
      'input[name*="code"]',
      'input[name*="token"]',
      'input[autocomplete="one-time-code"]'
    ];
    const okCode = await fillFirstVisible(page, codeSelectors, clientCode, 35000);
    if (!okCode) {
      throw new Error("Campo do código do cliente não encontrado.");
    }
    await delayStep(5);

    setSessionStep(session, "confirm_sms", "Confirmando código SMS…");
    if (!(await clickContinuar(page))) {
      throw new Error("Botão Continuar (código) não encontrado.");
    }
    await dismissCookieBanner(page);
    await session?.m4uAuthCapture?.waitForSessionsResult?.(20000);
    await delayStep(6);

    setSessionStep(session, "validate_sms", "Validando login após SMS…");
    await assertAuthSurvivedAfterCode(page, session);
    await leaveLandingAfterSmsOk(session);
    await persistAuthState(session);
  } else if (isWebPortalSession(session)) {
    setSessionStep(session, "web_link_auth_ok", "Logado via JWT — pagamento direto…");
  } else {
    setSessionStep(session, "reuse_sms_session", "Reusando sessão autenticada (sem novo SMS)…");
    await ensureAuthenticatedHome(session);
  }

  if (isPaymentErrorUrl(page.url()) && !session.smsAuthenticated) {
    throw new Error("Fluxo caiu em tela de pagamento recusado.");
  }

  if (isWebPortalSession(session)) {
    return runWebLinkRechargeWithRetry(session, payload);
  }

  return runCardAndPayWithGenericRetry(session, payload);
};

const isWebPortalAuthed = (url) =>
  /\/minhaclaro_web\/(numero|home|pagamento|meus-dados|landing|smartcheckout|confirmacao-beneficio)/i.test(
    url || ""
  );

const waitForWebPortalAuth = async (page, session, timeoutMs = 45000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const u = page.url() || "";
    // JWT ainda em select-login — aguarda redirect antes de seguir recarga
    if (/\/select-login/i.test(u)) {
      await sleep(400);
      continue;
    }
    if (isWebPortalAuthed(u)) return true;
    if (await hasAuthenticatedUiMarkers(page)) return true;
    const cust = session?.m4uAuthCapture?.lastCustomer?.();
    if (cust?.status === 200) return true;
    await sleep(400);
  }
  return false;
};

/** Link JWT minhaclaro_web — login sem SMS + pagamento opcional. */
export const startSessionFromWebLink = async (payload) => {
  const browserName = resolveBrowserName(payload);
  const accessNumber = normalizeBrMobile(payload?.accessNumber || payload?.claroNumber);
  const rechargeTargetNumber = normalizeBrMobile(
    payload?.rechargeTargetNumber || payload?.accessNumber || payload?.claroNumber
  );
  if (!accessNumber) {
    throw new Error("accessNumber (ou claroNumber) é obrigatório.");
  }

  let loginUrl = String(payload?.loginUrl || payload?.link || "").trim();
  if (!loginUrl) {
    throw new Error("loginUrl é obrigatório.");
  }
  loginUrl = normalizeMinhaClaroWebLink(loginUrl) || loginUrl.replace(/\/controle_web\//gi, "/minhaclaro_web/");

  try {
    const prev = await closeSessionsByAccessNumber(accessNumber);
    if (prev.closed > 0) {
      console.log(
        `[claro] web-link: fechou ${prev.closed} sessão(ões) antiga(s) do acesso ${accessNumber}`
      );
    }
  } catch (err) {
    console.warn(`[claro] web-link: close prévio ${accessNumber}: ${err?.message || err}`);
  }

  const releaseSlot = await acquireBrowserSlot(`weblink:${accessNumber}`);
  let browser = null;
  let sessionId;
  let session;
  try {
    browser = await launchBrowser(browserName);
    const context = await browser.newContext({
      ...devices["iPhone 12"],
      viewport: {
        width: config.mobileViewportWidth,
        height: config.mobileViewportHeight
      }
    });
    const page = await context.newPage();
    const m4uAuthCapture = attachM4uAuthCapture(context);

    sessionId = uuidv4();
    session = {
      id: sessionId,
      browser,
      context,
      page,
      m4uAuthCapture,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "created",
      browserName,
      accessNumber,
      rechargeTargetNumber,
      claroNumber: accessNumber,
      pamTouchCommitted: false,
      smsAuthenticated: false,
      authStatePath: null,
      webLoginUrl: loginUrl,
      webPortal: true,
      inspect: Boolean(payload?.inspect)
    };
    const { gateCapture } = attachClaroNetworkHooks(context, session);
    session.gateCapture = gateCapture;
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
  ensureIdleSweep();

  const page = session.page;
  try {
    setSessionStep(session, "open_web_link", "Abrindo link Claro (sem SMS)…");
    console.log(`[claro] web-link goto ${loginUrl.slice(0, 80)}…`);
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await dismissCookieBanner(page);
    await sleep(1200);

    if (!(await waitForWebPortalAuth(page, session))) {
      await saveStepDebug(page, "web_link_auth_fail");
      throw new Error(`Login web não completou. url=${page.url() || "?"}`);
    }

    session.smsAuthenticated = true;
    await persistAuthState(session);

    if (payload?.inspect || session.inspect) {
      session.status = "inspect";
      session.inspect = true;
      await persistGateDebug(session.gateCapture?.best?.(), "inspect", session.gateCapture);
      await captureWebLinkStep(page, "inspect_aberto", session);
      setSessionStep(session, "inspect", "Aberto. Sem cliques — aguardando o fluxo.");
      console.log(`[claro] INSPECT url=${page.url()}`);
      return {
        sessionId,
        status: "inspect",
        url: page.url(),
        captures: session.gateCapture?.captures?.length || 0,
        browserLeftOpen: true,
        browser: browserName
      };
    }

    if (!payload?.rechargeValue) {
      session.status = "ready_retry";
      setSessionStep(session, "ready_retry", "Logado via link web.");
      return {
        sessionId,
        status: session.status,
        link: loginUrl,
        accessNumber,
        rechargeTargetNumber,
        smsAuthenticated: true,
        browser: browserName
      };
    }

    return await submitCodeAndFinish(sessionId, {
      clientCode: "00000",
      rechargeValue: payload.rechargeValue,
      pamInfo: payload.pamInfo || null,
      inspect: Boolean(payload.inspect)
    });
  } catch (err) {
    session.status = "error_manual";
    session.lastError = String(err?.message || err);
    setSessionStep(session, "erro", session.lastError);
    const classified = classifyClaroFlowError(session.lastError, session);
    if (sessionPageAlive(session)) {
      scheduleSessionClose(sessionId, 0);
    }
    return {
      sessionId,
      status: session.status,
      error: session.lastError,
      claroErrorCode: err?.claroErrorCode || classified.code,
      message: classified.message || session.lastError,
      link: loginUrl,
      browserLeftOpen: false,
      closeInSeconds: 0
    };
  }
};

const postCleanupCloseDelayMs = (session) =>
  session?.cadastroExcluido ? 1500 : Math.min(config.keepBrowserOpenSeconds || 3, 5) * 1000;

const scheduleSessionClose = (sessionId, delayMs) => {
  setTimeout(async () => {
    try {
      await closeSession(sessionId);
    } catch (err) {
      console.error(`[claro] falha ao fechar sessão ${sessionId}:`, err);
    }
  }, delayMs);
};

/**
 * Fecha sessões paradas após SESSION_IDLE_TIMEOUT_SECONDS.
 * Inclui waiting_sms, ready_retry, error_manual, auth_expired — só poupa status=running.
 * (Antes: sessões autenticadas nunca fechavam e ocupavam as 5 vagas para sempre.)
 */
const sweepIdleSessions = async () => {
  const idleSec = config.sessionIdleTimeoutSeconds;
  if (!idleSec || idleSec <= 0) return;
  const limitMs = idleSec * 1000;
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    // Em execução ativa o fluxo já atualiza lastActivity via setSessionStep.
    if (session.status === "running" || session.status === "inspect" || session.runLock || session.closing || session.inspect) continue;
    const last = session.lastActivityAt || session.createdAt || now;
    const idleFor = now - last;
    if (idleFor < limitMs) continue;
    console.log(
      `[claro] sessão ${sessionId} inativa há ${Math.floor(idleFor / 1000)}s ` +
        `(status=${session.status} smsAuth=${Boolean(session.smsAuthenticated)}) — fechando (limite ${idleSec}s)`
    );
    setSessionStep(session, "idle_timeout", `Sessão fechada por inatividade (${idleSec}s)`);
    try {
      await closeSession(sessionId);
    } catch (err) {
      console.error(`[claro] falha ao fechar sessão idle ${sessionId}:`, err);
    }
  }
};

let idleSweepStarted = false;
const ensureIdleSweep = () => {
  if (idleSweepStarted) return;
  idleSweepStarted = true;
  const everyMs = 15000;
  setInterval(() => {
    sweepIdleSessions().catch((err) => {
      console.error("[claro] idle sweep:", err);
    });
  }, everyMs);
};

const isPaymentFailure = (paymentResult, runError) => {
  if (runError) return true;
  if (!paymentResult) return false;
  if (gateIndicatesSuccess(paymentResult.gateResponse)) return false;
  if (paymentResult.pagamentoErro) return true;
  const st = String(paymentResult.status || "").toLowerCase();
  if (st === "3ds_blocked") return true;
  if (st === "success") {
    if (gateIndicatesSuccess(paymentResult.gateResponse)) return false;
    if (isPaymentSuccessUrl(paymentResult.url)) return false;
    return true;
  }
  return st === "error" || st === "timeout";
};

export const startSession = async (payload) => {
  const browserName = resolveBrowserName(payload);
  const envLocked = isBrowserLockedByEnv();
  console.log(
    `[claro] Navegador: ${browserName}` +
      (envLocked
        ? ` (fixo via CLARO/.env: ${process.env.BROWSER_NAME || process.env.DEFAULT_BROWSER})`
        : ` (payload/UI: ${payload?.browser ?? payload?.browserName ?? "padrão"})`)
  );

  const releaseSlot = await acquireBrowserSlot(
    `start:${normalizeBrMobile(payload?.accessNumber || payload?.claroNumber) || "?"}`
  );
  let browser = null;
  let sessionId;
  let session;
  try {
    browser = await launchBrowser(browserName);
    const context = await browser.newContext({
      ...devices["iPhone 12"],
      viewport: {
        width: config.mobileViewportWidth,
        height: config.mobileViewportHeight
      }
    });
    const page = await context.newPage();
    const m4uAuthCapture = attachM4uAuthCapture(context);

    sessionId = uuidv4();
    session = {
      id: sessionId,
      browser,
      context,
      page,
      m4uAuthCapture,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "created",
      browserName,
      accessNumber: normalizeBrMobile(payload?.accessNumber || payload?.claroNumber),
      rechargeTargetNumber: normalizeBrMobile(
        payload?.rechargeTargetNumber || payload?.accessNumber || payload?.claroNumber
      ),
      /** Legado / ledger */
      claroNumber: normalizeBrMobile(payload?.accessNumber || payload?.claroNumber),
      pamTouchCommitted: false,
      smsAuthenticated: false,
      authStatePath: null
    };
    const { gateCapture } = attachClaroNetworkHooks(context, session);
    session.gateCapture = gateCapture;
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
  ensureIdleSweep();

  try {
    setSessionStep(session, "start", "Iniciando navegador…");
    await runBeforeCode(session, payload);
    session.status = "waiting_code";
    setSessionStep(
      session,
      "waiting_sms",
      config.sessionIdleTimeoutSeconds > 0
        ? `Aguardando código SMS… (fecha em ${Math.round(config.sessionIdleTimeoutSeconds / 60)} min sem atividade)`
        : "Aguardando código SMS…"
    );
    return {
      sessionId,
      status: session.status,
      step: session.step,
      stepLabel: session.stepLabel,
      idleTimeoutSeconds: config.sessionIdleTimeoutSeconds || null,
      browser: browserName,
      accessNumber: session.accessNumber,
      rechargeTargetNumber: session.rechargeTargetNumber
    };
  } catch (err) {
    session.status = "error_manual";
    session.lastError = String(err?.message || err);
    setSessionStep(session, "erro", session.lastError);
    const leaveOpen = config.closeBrowserOnlyOnSuccess;
    if (!leaveOpen) {
      scheduleSessionClose(sessionId, 1500);
    }
    return {
      sessionId,
      status: session.status,
      step: session.step,
      stepLabel: session.stepLabel,
      error: session.lastError,
      browserLeftOpen: leaveOpen,
      closeInSeconds: leaveOpen ? null : 1.5,
      message: leaveOpen
        ? "Falha antes do SMS — navegador mantido aberto. Use Fechar sessão quando terminar."
        : "Falha antes do SMS — navegador será fechado."
    };
  }
};

export const submitCodeAndFinish = async (sessionId, payload) => {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error("Sessão não encontrada.");
  }

  beginSessionRun(session, "enviar o código");

  let paymentResult = null;
  let runError = null;
  touchSession(session);

  try {
    setSessionStep(session, "apos_sms", "Continuando após código SMS…");
    try {
      paymentResult = await runAfterCode(session, payload);
    } catch (err) {
      runError = err;
      setSessionStep(session, "erro", String(err?.message || err));
    }

    // Exceção de fluxo após cadastrar cartão: tira a GG da conta Claro antes de fechar
    if (
      runError &&
      session.pamTouchCommitted &&
      sessionPageAlive(session) &&
      !isWebPortalSession(session)
    ) {
      try {
        await removeCardAfterSuccessfulPay(session);
      } catch (e) {
        console.warn(`[claro] limpar cartão pós-erro fluxo: ${e?.message || e}`);
      }
    }

    let ledger = null;
    try {
      ledger = finalizePamLedger(session, payload, paymentResult, runError);
    } catch (e) {
      console.error("finalizePamLedger:", e);
    }

    session.paymentResult = paymentResult;
    const failed = isPaymentFailure(paymentResult, runError);

    if (failed) {
      const errText = String(runError?.message || runError || "");
      if (/expirou|navegador.*fechado|landing|novo SMS|sms_invalid|cadastro_deletado/i.test(errText)) {
        markAuthLost(session);
      }
      if (runError?.claroErrorCode === "sms_invalid" || runError?.claroErrorCode === "cadastro_deletado") {
        markAuthLost(session);
      }
      let keepForRetry = Boolean(session.smsAuthenticated) && sessionPageAlive(session);
      if (
        runError?.claroErrorCode === "sms_invalid" ||
        runError?.claroErrorCode === "cadastro_deletado" ||
        runError?.claroErrorCode === "valor_indisponivel" ||
        classified.code === "3ds_blocked" ||
        paymentResult?.status === "3ds_blocked"
      ) {
        keepForRetry = false;
      }
      const gateErr =
        paymentResult?.gateMessage ||
        paymentResult?.gateCode ||
        paymentResult?.message ||
        null;
      session.lastError = runError
        ? String(runError.message || runError)
        : String(gateErr || "Pagamento não concluído");
      const classified = classifyFailedClaroPayment(runError, paymentResult, session, session.lastError);
      const isListaNeg = classified.code === "lista_negativa_claro";
      const isFatalCard =
        classified.code === "cartao_limite_conta" || classified.code === "cartao_limite_vinculo";
      if (isListaNeg || isFatalCard) {
        keepForRetry = false;
        if (isListaNeg) markAuthLost(session);
      }
      // Erro de fluxo sem gate: fecha browser — PAM já foi devolvido ao info
      if ((classified.code === "erro_fluxo" && !paymentResult?.gateCode) || (runError && !paymentResult)) {
        keepForRetry = false;
      }
      // Gate recusou mas SMS ok → mantém sessão pra retry-pay / testes
      if (paymentResult?.gateCode && session.smsAuthenticated && !isListaNeg && !isFatalCard) {
        keepForRetry = true;
        session.status = "ready_retry";
      }
      // cs minhaclaro_web: JWT autentica mas o bot não reutiliza o mesmo browser
      if (isWebPortalSession(session)) {
        keepForRetry = false;
      }
      session.lastError = classified.message || session.lastError;
      session.status = keepForRetry
        ? "ready_retry"
        : session.status === "auth_expired"
          ? "auth_expired"
          : "error_manual";
      // Só mantém aberto se ainda dá retry; CLOSE_BROWSER_ONLY_ON_SUCCESS não trava erro pós-limpeza
      let leaveOpen = keepForRetry && sessionPageAlive(session);
      if (isListaNeg || isFatalCard || session.cadastroExcluido) leaveOpen = false;
      if ((classified.code === "erro_fluxo" && !paymentResult?.gateCode) || (runError && !paymentResult)) {
        leaveOpen = false;
      }
      const closeSec = leaveOpen
        ? null
        : isWebPortalSession(session) ||
            session.cadastroExcluido ||
            isListaNeg ||
            isFatalCard
          ? 0
          : Math.min(config.keepBrowserOpenSeconds, 3);
      const out = {
        sessionId,
        status: session.status,
        step: session.step,
        stepLabel: session.stepLabel,
        accessNumber: session.accessNumber || null,
        rechargeTargetNumber: session.rechargeTargetNumber || null,
        rechargeValue: payload?.rechargeValue != null ? String(payload.rechargeValue) : null,
        error: session.lastError,
        claroErrorCode: classified.code,
        smsAuthenticated: Boolean(session.smsAuthenticated),
        canRetryWithoutSms: keepForRetry,
        gateCode: paymentResult?.gateCode ?? null,
        gateMessage: paymentResult?.gateMessage ?? null,
        gateNsu: paymentResult?.gateNsu ?? null,
        paymentResult,
        ledger,
        browserLeftOpen: leaveOpen,
        closeInSeconds: closeSec,
        message: isWebPortalSession(session)
          ? "Recarga cs não concluída — navegador será fechado."
          : keepForRetry
          ? "Erro após SMS — navegador mantido aberto. Use Retry sem SMS (não feche a janela)."
          : classified.code === "sms_invalid"
            ? "Código SMS incorreto ou expirado — faça nova recarga e envie o código certo."
            : classified.code === "cadastro_deletado"
              ? "Cadastro Claro Recarga excluído/indisponível — cliente precisa refazer cadastro no site Claro."
              : classified.code === "valor_indisponivel"
                ? classified.message || "Valor não disponível nesse número."
              : classified.code === "3ds_blocked"
                ? classified.message ||
                  "3DS exigido pelo banco — recarga abortada (autenticação manual não suportada)."
              : isListaNeg
                ? classified.message ||
                  "Linha na lista negativa Claro — navegador fechado; número bloqueado no bot por 30 dias."
                : classified.code === "erro_fluxo"
                ? classified.message ||
                  "Falha no fluxo Claro após o SMS — não confundir com código SMS errado."
                : /expirou|fechado|novo SMS|landing|c[oó]digo/i.test(session.lastError)
                ? "Login/SMS Claro falhou — use /recarga de novo e envie o código novo (só os dígitos)."
                : leaveOpen
                  ? "Fluxo com erro — navegador mantido aberto. Use Fechar sessão quando terminar."
                  : "Fluxo com erro — navegador será fechado."
      };
      if (!keepForRetry) {
        try {
          session.gateCapture?.detach?.();
          session.m4uAuthCapture?.detach?.();
        } catch {
          // ignore
        }
      }
      if (!leaveOpen) {
        scheduleSessionClose(sessionId, (closeSec ?? 0) * 1000);
      }
      return out;
    }

    session.status = "done";
    try {
      session.gateCapture?.detach?.();
    } catch {
      // ignore
    }

    const successOut = {
      sessionId,
      status: session.status,
      step: session.step,
      stepLabel: session.stepLabel,
      accessNumber: session.accessNumber,
      rechargeTargetNumber: session.rechargeTargetNumber,
      gateCode: paymentResult?.gateCode ?? null,
      gateMessage: paymentResult?.gateMessage ?? null,
      gateNsu: paymentResult?.gateNsu ?? null,
      paymentResult,
      ledger,
      closeInSeconds: config.keepBrowserOpenSeconds
    };

    // Responde sucesso já; limpa cartão/cadastro em background e só então fecha o browser
    if (session.needsPosSucessoCleanup && sessionPageAlive(session)) {
      session.needsPosSucessoCleanup = false;
      setSessionStep(session, "limpeza_pos_sucesso", "Limpando cartão/cadastro (cliente já notificado)…");
      Promise.resolve()
        .then(async () => {
          await removeCardAfterSuccessfulPay(session);
          await excluirCadastroClaro(session, "pós-sucesso");
        })
        .catch((e) => console.warn(`[claro] limpeza pós-sucesso: ${e?.message || e}`))
        .finally(() => {
          scheduleSessionClose(sessionId, postCleanupCloseDelayMs(session));
        });
    } else {
      scheduleSessionClose(sessionId, postCleanupCloseDelayMs(session));
    }

    return successOut;
  } finally {
    endSessionRun(session);
  }
};

export const resendCode = async (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error("Sessão não encontrada.");
  }
  touchSession(session);
  const { page } = session;
  const ok = await clickByText(page, ["Reenviar código", "Reenviar codigo"]);
  if (!ok) {
    throw new Error("Botão de reenviar código não encontrado.");
  }
  setSessionStep(session, "waiting_sms", "Código reenviado — aguardando SMS…");
  return { sessionId, resent: true };
};

/**
 * Retry de pagamento sem novo SMS — exige sessão já autenticada (smsAuthenticated).
 * Body: { pamInfo, rechargeValue }
 */
export const retryPayAfterAuth = async (sessionId, payload) => {
  const session = await getOrRestoreSession(sessionId, payload);
  if (!session.smsAuthenticated) {
    throw new Error("Sessão ainda não autenticada por SMS — envie o código primeiro.");
  }

  beginSessionRun(session, "usar Retry sem SMS");

  const activeId = session.id;
  let paymentResult = null;
  let runError = null;
  touchSession(session);
  session.pamTouchCommitted = false;

  try {
    setSessionStep(session, "retry_pay", "Retry sem SMS — novo cartão/pagamento…");
    session.useExistingSavedCard = false;

    if (!session.gateCapture && session.context) {
      attachClaroNetworkHooks(session.context, session);
    }

    try {
      await ensureAuthenticatedHome(session);
      paymentResult = await runCardAndPayWithGenericRetry(session, payload);
    } catch (err) {
      runError = err;
      setSessionStep(session, "erro", String(err?.message || err));
    }

    if (runError && session.pamTouchCommitted && sessionPageAlive(session) && !isWebPortalSession(session)) {
      try {
        await removeCardAfterSuccessfulPay(session);
      } catch (e) {
        console.warn(`[claro] limpar cartão pós-erro fluxo (retry): ${e?.message || e}`);
      }
    }

    let ledger = null;
    try {
      ledger = finalizePamLedger(session, payload, paymentResult, runError);
    } catch (e) {
      console.error("finalizePamLedger:", e);
    }

    session.paymentResult = paymentResult;
    const failed = isPaymentFailure(paymentResult, runError);

    if (failed) {
      const errText = String(runError?.message || runError || "");
      if (/expirou|navegador.*fechado|landing|novo SMS/i.test(errText)) {
        markAuthLost(session);
      }
      let keepForRetry = Boolean(session.smsAuthenticated) && sessionPageAlive(session);
      session.status = keepForRetry ? "ready_retry" : session.status === "auth_expired" ? "auth_expired" : "error_manual";
      session.lastError = runError
        ? String(runError.message || runError)
        : String(paymentResult?.gateMessage || paymentResult?.message || "Pagamento não concluído");
      const classified = classifyFailedClaroPayment(runError, paymentResult, session, session.lastError);
      const isListaNeg = classified.code === "lista_negativa_claro";
      const isFatalCard =
        classified.code === "cartao_limite_conta" || classified.code === "cartao_limite_vinculo";
      if (isListaNeg || isFatalCard) {
        keepForRetry = false;
        if (isListaNeg) markAuthLost(session);
      }
      session.lastError = classified.message || session.lastError;
      session.status = keepForRetry ? "ready_retry" : session.status === "auth_expired" ? "auth_expired" : "error_manual";
      const genericMsg = isGenericGateFailure(paymentResult)
        ? `Pagamento recusado (${gateRetryLabel(paymentResult)}) — já tentamos cartões extras; pode usar Retry sem SMS de novo.`
        : null;
      const leaveOpen = keepForRetry && !isListaNeg && !isFatalCard && !session.cadastroExcluido && sessionPageAlive(session);
      if (!leaveOpen) {
        try {
          session.gateCapture?.detach?.();
          session.m4uAuthCapture?.detach?.();
        } catch {
          // ignore
        }
        scheduleSessionClose(
          activeId,
          session.cadastroExcluido || isListaNeg || isFatalCard
            ? 0
            : Math.min(config.keepBrowserOpenSeconds, 3) * 1000
        );
      }
      return {
        sessionId: activeId,
        status: session.status,
        step: session.step,
        stepLabel: session.stepLabel,
        accessNumber: session.accessNumber,
        rechargeTargetNumber: session.rechargeTargetNumber,
        error: session.lastError,
        claroErrorCode: classified.code,
        smsAuthenticated: Boolean(session.smsAuthenticated),
        canRetryWithoutSms: keepForRetry,
        restoredFromDisk: Boolean(session.restoredFromDisk),
        gateCode: paymentResult?.gateCode ?? null,
        gateMessage: paymentResult?.gateMessage ?? null,
        gateNsu: paymentResult?.gateNsu ?? null,
        paymentResult,
        ledger,
        browserLeftOpen: leaveOpen,
        closeInSeconds: leaveOpen ? null : isListaNeg ? 0 : Math.min(config.keepBrowserOpenSeconds, 3),
        message: keepForRetry
          ? genericMsg ||
            "Retry falhou — navegador ainda aberto. Pode tentar Retry sem SMS de novo (não feche a janela)."
          : isListaNeg
            ? classified.message || "Lista negativa Claro — navegador fechado."
            : "Login Claro perdido — inicie de novo e envie SMS."
      };
    }

    session.status = "done";
    try {
      session.gateCapture?.detach?.();
    } catch {
      // ignore
    }

    const successOut = {
      sessionId: activeId,
      status: session.status,
      step: session.step,
      stepLabel: session.stepLabel,
      accessNumber: session.accessNumber,
      rechargeTargetNumber: session.rechargeTargetNumber,
      smsAuthenticated: true,
      canRetryWithoutSms: false,
      gateCode: paymentResult?.gateCode ?? null,
      gateMessage: paymentResult?.gateMessage ?? null,
      gateNsu: paymentResult?.gateNsu ?? null,
      paymentResult,
      ledger,
      closeInSeconds: config.keepBrowserOpenSeconds
    };

    if (session.needsPosSucessoCleanup && sessionPageAlive(session)) {
      session.needsPosSucessoCleanup = false;
      setSessionStep(session, "limpeza_pos_sucesso", "Limpando cartão/cadastro (cliente já notificado)…");
      Promise.resolve()
        .then(async () => {
          await removeCardAfterSuccessfulPay(session);
          await excluirCadastroClaro(session, "pós-sucesso");
        })
        .catch((e) => console.warn(`[claro] limpeza pós-sucesso (retry): ${e?.message || e}`))
        .finally(() => {
          scheduleSessionClose(activeId, postCleanupCloseDelayMs(session));
        });
    } else {
      scheduleSessionClose(activeId, postCleanupCloseDelayMs(session));
    }

    return successOut;
  } finally {
    endSessionRun(session);
  }
};

/**
 * Só reabre o navegador logado (storageState) — sem pagar.
 * Útil pra inspecionar a conta / valor na tela.
 */
export const restoreLoggedInOnly = async (payload = {}) => {
  const access = normalizeBrMobile(payload.accessNumber || payload.claroNumber);
  if (!access) throw new Error("accessNumber é obrigatório.");

  // Fecha fantasma SMS do mesmo número pra não ocupar vaga
  const live = findLiveSessionByAccess(access);
  if (live) {
    try {
      await closeSession(live.id);
    } catch {
      // ignore
    }
  }

  const sessionId = String(payload.sessionId || `restore-${access}`);
  const session = await getOrRestoreSession(sessionId, {
    ...payload,
    accessNumber: access,
    rechargeTargetNumber: normalizeBrMobile(payload.rechargeTargetNumber || access)
  });

  try {
    await ensureAuthenticatedHome(session);
  } catch (err) {
    // Mesmo sem home perfeita, deixa o browser aberto se a página vive
    console.warn(`[claro] restoreLoggedInOnly home: ${err?.message || err}`);
  }

  session.status = "ready_retry";
  session.smsAuthenticated = true;
  session.canRetryWithoutSms = true;
  setSessionStep(session, "ready_retry", "Sessão restaurada logada (sem pagar) — browser aberto");
  touchSession(session);

  return {
    sessionId: session.id,
    status: session.status,
    step: session.step,
    stepLabel: session.stepLabel,
    accessNumber: session.accessNumber,
    rechargeTargetNumber: session.rechargeTargetNumber,
    smsAuthenticated: true,
    canRetryWithoutSms: true,
    restoredFromDisk: Boolean(session.restoredFromDisk),
    browserLeftOpen: true,
    message: "Navegador reaberto com login salvo. Não iniciou pagamento."
  };
};

const inspectClickInRoot = async (root, re) => {
  const btn = root.getByRole("button", { name: re }).first();
  if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
    await btn.click({ timeout: 4000 });
    return true;
  }
  const el = root.getByText(re).first();
  if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
    await el.click({ timeout: 4000 });
    return true;
  }
  return false;
};

const inspectGatePayload = (paymentResult, session) => {
  const cap = paymentResult?.gateResponse;
  const sum = cap
    ? summarizeGateCapture(cap)
    : {
        code: paymentResult?.gateCode,
        message: paymentResult?.gateMessage,
        nsu: paymentResult?.gateNsu,
        summary: paymentResult?.gateMessage || paymentResult?.message || ""
      };
  return {
    paymentStatus: paymentResult?.status || null,
    message: paymentResult?.message || null,
    gateCode: paymentResult?.gateCode || sum.code || null,
    gateMessage: paymentResult?.gateMessage || sum.message || sum.summary || null,
    gateNsu: paymentResult?.gateNsu || sum.nsu || null,
    gateUrl: cap?.url || null,
    gateHttpStatus: cap?.httpStatus ?? null,
    gateMethod: cap?.method || null,
    gateBody: cap?.body ? sanitizeGateBody(cap.body, 6000) : null,
    captures: session?.gateCapture?.captures?.length || 0
  };
};

const inspectPayOnce = async (session, options = {}) => {
  const { page } = session;
  if (!session.gateCapture && session.context) {
    attachClaroNetworkHooks(session.context, session);
  }
  const expOverride = options.cardExpiry ?? options.cardExp ?? options.expiryOverride;
  if (expOverride) {
    setSessionStep(session, "inspect", `Alterando validade -> ${normalizeCardExpiry(expOverride) || expOverride}…`);
    await patchEldoradoExpiryBeforePay(page, expOverride);
    await sleep(400);
  }
  setSessionStep(session, "pagar", "Confirmando pagamento (inspect)…");
  let payOk = await clickEldoradoPayButton(page, 15000);
  if (!payOk) {
    payOk = await clickInAnyFrame(
      page,
      ["Pagar R$", "Pagar", "Pagar agora", "Confirmar pagamento", "Confirmar", "Finalizar pagamento"],
      25000
    );
  }
  if (!payOk) throw new Error("Botão Pagar não encontrado.");
  await delayStep(21);
  await captureWebLinkStep(page, "after_pay_click", session);
  setSessionStep(session, "aguardando_gate", "Aguardando resposta da gate…");
  const paymentResult = await waitForPaymentResult(page, 120000, session.gateCapture);
  await captureWebLinkStep(page, `gate_${paymentResult?.status || "unknown"}`, session);
  await persistGateDebug(
    session.gateCapture?.best?.(),
    paymentResult?.status || "inspect",
    session.gateCapture
  );
  return paymentResult;
};

export const inspectClickOnce = async (sessionId, label, options = {}) => {
  const session = sessions.get(sessionId);
  if (!session?.page) throw new Error("Sessão não encontrada.");
  touchSession(session);
  const page = session.page;
  const text = String(label || "").trim();
  if (!text) throw new Error("label é obrigatório.");

  // Captura/loop antigo usava "__recapture__" e virava clique infinito que não acha nada.
  if (text.startsWith("__")) {
    touchSession(session);
    return {
      clicked: false,
      skipped: true,
      label: text,
      url: page.url(),
      captures: session.gateCapture?.captures?.length || 0,
      sessionId
    };
  }

  if (/^(pagar|pay)(\s|$)/i.test(text) || /^Pagar R\$/i.test(text)) {
    try {
      const paymentResult = await inspectPayOnce(session, options);
      const gate = inspectGatePayload(paymentResult, session);
      setSessionStep(
        session,
        "inspect",
        `Gate ${gate.paymentStatus}: ${(gate.gateMessage || gate.message || "").slice(0, 100)}`
      );
      console.log(
        `[claro] INSPECT pagar status=${gate.paymentStatus} code=${gate.gateCode} msg=${gate.gateMessage}`
      );
      return {
        clicked: true,
        paid: true,
        label: text,
        url: page.url(),
        sessionId,
        ...gate
      };
    } catch (err) {
      await captureWebLinkStep(page, "inspect_click", session);
      setSessionStep(session, "inspect", `Falha pagar: ${String(err?.message || err).slice(0, 80)}`);
      return {
        clicked: false,
        paid: false,
        error: String(err?.message || err),
        label: text,
        url: page.url(),
        captures: session.gateCapture?.captures?.length || 0,
        sessionId
      };
    }
  }

  if (/^(preencher|fill)\s+(cart|dados|pan)/i.test(text)) {
    try {
      await fillWebLinkCardDirect(session, options);
      await captureWebLinkStep(page, "after_fill_card", session);
      await persistGateDebug(session.gateCapture?.best?.(), "inspect", session.gateCapture);
      setSessionStep(session, "inspect", "Cartão preenchido (sem pagar)");
      console.log(`[claro] INSPECT preencheu cartão url=${page.url()}`);
      return {
        clicked: true,
        filled: true,
        label: text,
        url: page.url(),
        captures: session.gateCapture?.captures?.length || 0,
        sessionId
      };
    } catch (err) {
      await captureWebLinkStep(page, "inspect_click", session);
      setSessionStep(session, "inspect", `Falha ao preencher: ${String(err?.message || err).slice(0, 80)}`);
      console.warn(`[claro] INSPECT fill fail: ${err?.message || err}`);
      return {
        clicked: false,
        filled: false,
        error: String(err?.message || err),
        label: text,
        url: page.url(),
        captures: session.gateCapture?.captures?.length || 0,
        sessionId
      };
    }
  }

  if (/^(remover|limpar|excluir)\s+cart/i.test(text) || /^menu\s+cart/i.test(text) || text === "⋮") {
    const removed = await removeSavedCardsInCheckout(page);
    await sleep(800);
    await captureWebLinkStep(page, "inspect_click", session);
    await persistGateDebug(session.gateCapture?.best?.(), "inspect", session.gateCapture);
    setSessionStep(session, "inspect", `Removeu ${removed} cartão(ões)`);
    console.log(`[claro] INSPECT remover cartões n=${removed} url=${page.url()}`);
    return {
      clicked: removed > 0,
      removed,
      label: text,
      url: page.url(),
      captures: session.gateCapture?.captures?.length || 0,
      sessionId
    };
  }

  const re = new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  let clicked = await inspectClickInRoot(page, re);
  if (!clicked) {
    for (const frame of page.frames()) {
      try {
        if (await inspectClickInRoot(frame, re)) {
          clicked = true;
          break;
        }
      } catch {
        // frame pode ter navegado
      }
    }
  }
  if (clicked) {
    await dismissBonusModalIfVisible(page);
    if (/R\$\s*\d+/i.test(text)) {
      await waitForSmartCheckout(page, 25000);
      try {
        await throwIfPixOnlyCheckout(page, session);
      } catch (err) {
        setSessionStep(session, "valor_indisponivel", String(err?.message || err).slice(0, 120));
        return {
          clicked: true,
          label: text,
          url: page.url(),
          error: String(err?.message || err),
          claroErrorCode: err?.claroErrorCode || "valor_indisponivel",
          captures: session.gateCapture?.captures?.length || 0,
          sessionId
        };
      }
    }
  }
  await sleep(800);
  await captureWebLinkStep(page, "inspect_click", session);
  await persistGateDebug(session.gateCapture?.best?.(), "inspect", session.gateCapture);
  setSessionStep(session, "inspect", clicked ? `Clicou: ${text}` : `Não achou: ${text}`);
  console.log(`[claro] INSPECT click "${text}" ok=${clicked} url=${page.url()}`);
  return {
    clicked,
    label: text,
    url: page.url(),
    captures: session.gateCapture?.captures?.length || 0,
    sessionId
  };
};

const STUCK_SHOT_DIR = process.env.STUCK_SCREENSHOT_DIR || "/opt/cursor/artifacts/screenshots/stuck";

/** Print automático quando entra em passo crítico (antes de waits longos). */
const captureStuckSnapshot = async (session, tag) => {
  if (!session?.page) return null;
  try {
    const msisdn = session.accessNumber || "unknown";
    const stamp = Date.now();
    const base = path.join(STUCK_SHOT_DIR, `stuck_${msisdn}_${tag}_${stamp}`);
    await fs.mkdir(STUCK_SHOT_DIR, { recursive: true });
    await session.page.screenshot({ path: `${base}.png`, fullPage: true, timeout: 8000 }).catch(() => {});
    const frames = session.page.frames().map((f) => f.url()).filter((u) => u && u !== "about:blank");
    const meta = {
      tag,
      step: session.step,
      stepLabel: session.stepLabel,
      url: session.page.url(),
      frames,
      at: new Date().toISOString()
    };
    await fs.writeFile(`${base}.json`, JSON.stringify(meta, null, 2), "utf8").catch(() => {});
    console.log(`[claro][stuck-shot] ${tag} → ${base}.png`);
    return base;
  } catch (err) {
    console.warn(`[claro][stuck-shot] falha ${tag}: ${err?.message || err}`);
    return null;
  }
};

/** PNG da página atual (debug / print do checkout). */
export const screenshotSession = async (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session?.page) throw new Error("Sessão não encontrada ou browser fechado.");
  touchSession(session);
  const page = session.page;
  let buffer;
  try {
    buffer = await page.screenshot({ fullPage: true, timeout: 8000 });
  } catch (err) {
    throw new Error(`Screenshot indisponível (página ocupada): ${err?.message || err}`);
  }
  const frames = page.frames().map((f) => f.url()).filter((u) => u && u !== "about:blank");
  return {
    sessionId,
    step: session.step,
    stepLabel: session.stepLabel,
    url: page.url(),
    frames,
    buffer
  };
};

export const closeSessionsByAccessNumber = async (accessNumber) => {
  const n = String(accessNumber || "").replace(/\D/g, "");
  if (n.length !== 11) return { closed: 0, sessionIds: [] };
  const closed = [];
  for (const [sessionId, session] of sessions.entries()) {
    const a = String(session.accessNumber || session.claroNumber || "").replace(/\D/g, "");
    if (a === n) {
      const r = await closeSession(sessionId);
      if (r.closed) closed.push(sessionId);
    }
  }
  return { closed: closed.length, sessionIds: closed };
};

export const closeSession = async (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) {
    console.log(`[claro] close session=${sessionId} — já inexistente`);
    return { sessionId, closed: false };
  }
  if (session.closing) return { sessionId, closed: false, alreadyClosing: true };
  session.closing = true;
  const access = session.accessNumber || "?";
  const st = session.status || "?";

  try {
    await session.context.close();
  } catch {
    // ignore
  }
  try {
    await session.browser.close();
  } catch {
    // ignore
  }
  sessions.delete(sessionId);
  console.log(`[claro] sessão ${sessionId} fechada (status era ${st}, acesso ${access}) — vaga liberada`);
  return { sessionId, closed: true };
};
