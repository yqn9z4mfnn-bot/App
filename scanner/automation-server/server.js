import express from "express";
import { config } from "./config.js";
import {
  closeAllSessions,
  closeSession,
  closeSessionsByAccessNumber,
  cleanupSessionIfBrowserDead,
  getConcurrencyPublic,
  getSessionPublic,
  isBrowserLockedByEnv,
  listSessionsPublic,
  normalizeBrowserName,
  resendCode,
  restoreLoggedInOnly,
  retryPayAfterAuth,
  startSession,
  startSessionFromWebLink,
  submitCodeAndFinish,
  inspectClickOnce,
  screenshotSession
} from "./automation.js";
import { generateWebLoginLink } from "./linkGenerate.js";
import { readAttemptsTail } from "./pamLedger.js";

const app = express();
app.use(express.json());

app.get("/api/sessions", (_req, res) => {
  return res.json({
    ...getConcurrencyPublic(),
    sessions: listSessionsPublic()
  });
});

app.post("/api/sessions/close-all", async (_req, res) => {
  try {
    const result = await closeAllSessions();
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/session/:sessionId", async (req, res) => {
  const closed = await cleanupSessionIfBrowserDead(req.params.sessionId);
  if (closed) {
    return res.status(410).json({
      error: "Sessão encerrada (navegador fechado).",
      status: "closed",
      browserAlive: false
    });
  }
  const info = getSessionPublic(req.params.sessionId);
  if (!info) {
    return res.status(404).json({ error: "Sessão não encontrada.", status: "closed" });
  }
  return res.json(info);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    headless: config.headless,
    defaultBrowser: normalizeBrowserName(config.defaultBrowser),
    browserLockedByEnv: isBrowserLockedByEnv(),
    ...getConcurrencyPublic()
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    headless: config.headless,
    defaultBrowser: normalizeBrowserName(config.defaultBrowser),
    browserLockedByEnv: isBrowserLockedByEnv()
  });
});

app.get("/api/logs/tentativas", (req, res) => {
  try {
    const lim = Math.min(Math.max(parseInt(String(req.query.limit ?? "80"), 10) || 80, 1), 500);
    res.json({ attempts: readAttemptsTail(lim) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/link/generate", async (req, res) => {
  try {
    const body = req.body ?? {};
    const msisdn = String(body.msisdn || body.accessNumber || body.claroNumber || body.numero || "")
      .replace(/\D/g, "");
    const result = await generateWebLoginLink(msisdn);
    return res.json(result);
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

/** Abre link minhaclaro_web (JWT) e paga sem SMS. */
app.post("/api/session/start-web-link", async (req, res) => {
  try {
    const body = req.body ?? {};
    const result = await startSessionFromWebLink(body);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/session/start", async (req, res) => {
  try {
    const body = req.body ?? {};
    const accessRaw = body.accessNumber || body.claroNumber;
    const accessNumber = String(accessRaw ?? "").replace(/\D/g, "");
    const rechargeTargetNumber = String(
      body.rechargeTargetNumber ?? accessNumber
    ).replace(/\D/g, "");
    if (accessNumber.length !== 11) {
      return res.status(400).json({
        error: "accessNumber (ou claroNumber) é obrigatório com DDD + 9 dígitos."
      });
    }
    if (rechargeTargetNumber.length !== 11) {
      return res.status(400).json({
        error: "rechargeTargetNumber inválido (DDD + 9 dígitos)."
      });
    }

    const result = await startSession({
      claroNumber: accessNumber,
      accessNumber,
      rechargeTargetNumber,
      browser: body.browser ?? body.browserName
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/session/:sessionId/submit-code", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { clientCode, pamInfo, rechargeValue } = req.body ?? {};

    if (!clientCode || !rechargeValue) {
      return res.status(400).json({
        error: "clientCode e rechargeValue são obrigatórios (pamInfo opcional — senão claim do info.txt)."
      });
    }

    const result = await submitCodeAndFinish(sessionId, {
      clientCode,
      pamInfo: pamInfo || null,
      rechargeValue
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/session/:sessionId/resend-code", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await resendCode(sessionId);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/session/:sessionId/retry-pay", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const body = req.body ?? {};
    const { pamInfo, rechargeValue } = body;
    if (!rechargeValue) {
      return res.status(400).json({
        error: "rechargeValue é obrigatório (pamInfo opcional — senão claim do info.txt)."
      });
    }
    const result = await retryPayAfterAuth(sessionId, {
      pamInfo: pamInfo || null,
      rechargeValue,
      accessNumber: body.accessNumber || body.claroNumber,
      rechargeTargetNumber: body.rechargeTargetNumber,
      browser: body.browser ?? body.browserName
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/** Reabre só logado (storageState), sem SMS e sem pagar. */
app.post("/api/session/restore-login", async (req, res) => {
  try {
    const body = req.body ?? {};
    const result = await restoreLoggedInOnly({
      accessNumber: body.accessNumber || body.claroNumber,
      rechargeTargetNumber: body.rechargeTargetNumber,
      browser: body.browser ?? body.browserName,
      sessionId: body.sessionId
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/session/:sessionId/screenshot", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const shot = await screenshotSession(sessionId);
    res.set("Content-Type", "image/png");
    res.set("X-Claro-Step", String(shot.step || ""));
    res.set("X-Claro-Url", String(shot.url || ""));
    return res.send(shot.buffer);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/session/:sessionId/inspect-click", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const label = String(req.body?.label || req.body?.text || "").trim();
    const result = await inspectClickOnce(sessionId, label, {
      pamInfo: req.body?.pamInfo,
      rechargeValue: req.body?.rechargeValue,
      cardExpiry: req.body?.cardExpiry ?? req.body?.cardExp ?? req.body?.expiryOverride
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/session/:sessionId/close", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await closeSession(sessionId);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/sessions/close-by-msisdn", async (req, res) => {
  try {
    const msisdn =
      req.body?.msisdn || req.body?.accessNumber || req.body?.claroNumber || req.body?.numero || "";
    const result = await closeSessionsByAccessNumber(msisdn);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.listen(config.port, () => {
  console.log(`API online em http://localhost:${config.port}`);
});
