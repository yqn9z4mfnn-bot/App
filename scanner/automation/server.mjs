#!/usr/bin/env node
import express from 'express';
import { config } from './config.mjs';
import { describeProxy, proxyEnabled } from '../lib/proxy.mjs';
import {
  closeSession,
  getConcurrencyPublic,
  getSessionPublic,
  startSessionFromWebLink,
  startSessionFromCheckoutLink,
} from './sessions.mjs';
import { isBrowserLockedByEnv, normalizeBrowserName } from './browser.mjs';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    headless: config.headless,
    defaultBrowser: normalizeBrowserName(config.defaultBrowser),
    browserLockedByEnv: isBrowserLockedByEnv(),
    ...getConcurrencyPublic(),
  });
});

app.get('/api/session/:sessionId', (req, res) => {
  const info = getSessionPublic(req.params.sessionId);
  if (!info) return res.status(404).json({ error: 'Sessão não encontrada.' });
  return res.json(info);
});

/** Abre link JWT minhaclaro_web no Edge e paga (sem SMS). */
app.post('/api/session/start-web-link', async (req, res) => {
  try {
    const body = req.body ?? {};
    const result = await startSessionFromWebLink(body);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/** HTTP prepara checkout → Edge abre só Eldorado e paga. */
app.post('/api/session/start-checkout-link', async (req, res) => {
  try {
    const body = req.body ?? {};
    const result = await startSessionFromCheckoutLink(body);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/session/:sessionId/close', async (req, res) => {
  try {
    const result = await closeSession(req.params.sessionId);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.listen(config.port, () => {
  console.log(`[automation] API online em http://127.0.0.1:${config.port}`);
  console.log(`[automation] browser=${normalizeBrowserName(config.defaultBrowser)} headless=${config.headless}`);
  console.log('[automation] 3DS: encerra gate-wait na hora (sem espera frictionless)');
  const p = describeProxy();
  console.log(`[automation] proxy=${p || (proxyEnabled() ? 'config incompleta' : 'OFF')}`);
});
