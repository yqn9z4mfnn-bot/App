import express from 'express';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { getDataDir } from '../lib/data-dir.mjs';
import {
  createAdminSession,
  validateAdminSession,
  revokeAdminSession,
  listTelegramUsers,
  countTelegramUsers,
  setTelegramUserAllowed,
  getTelegramUser,
  setTelegramUserAdmin,
  getBotPauseState,
  setBotPaused,
  listRechargeEvents,
  countRechargeEvents,
  countRechargeEventsByStatus,
  rechargeStatsSince,
  listAudit,
  insertAudit,
} from '../lib/admin-db.mjs';
import {
  listNumbers,
  countNumbers,
  countWithValues,
  getNumber,
  deleteNumber,
  listErrors,
  listValueStock,
} from '../lib/numbers-db.mjs';
import { createCardListStore } from '../lib/card-list.mjs';
import { parseCardInput } from '../lib/card-parse.mjs';
import { describeProxy, proxyEnabled } from '../lib/proxy.mjs';
import { repairRechargeRow } from '../lib/recharge-events.mjs';
import { backfillApprovedRecharges } from '../lib/approved-backfill.mjs';
import { invalidateBotPauseCache } from '../lib/bot-pause.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const DATA_DIR = getDataDir();
const cardList = createCardListStore(DATA_DIR);

const ADMIN_PORT = Number(process.env.ADMIN_PORT || 3080);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const AUTOMATION_URL = (process.env.AUTOMATION_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

function envPath() {
  return join(DATA_DIR, '.env');
}

function readEnvFile() {
  const path = envPath();
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1);
  }
  return out;
}

function writeEnvKey(key, value) {
  const path = envPath();
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  let found = false;
  const next = lines.map((line) => {
    if (line.trim().startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  writeFileSync(path, `${next.filter((l, i, a) => !(i === a.length - 1 && l === '')).join('\n')}\n`, {
    mode: 0o600,
  });
}

function readNewBytes(filePath, afterBytes) {
  const stat = statSync(filePath);
  const size = stat.size;
  if (afterBytes >= size) {
    return { text: '', size, mtime: stat.mtimeMs };
  }
  const start = Math.max(0, afterBytes);
  const length = size - start;
  const buf = Buffer.alloc(length);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buf, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return { text: buf.toString('utf8'), size, mtime: stat.mtimeMs };
}

function tailFile(filePath, { lines = 200, afterBytes = null } = {}) {
  if (!existsSync(filePath)) {
    return { path: filePath, lines: [], size: 0, mtime: null, totalLines: 0, appended: false };
  }
  const stat = statSync(filePath);
  if (afterBytes != null && Number.isFinite(afterBytes) && afterBytes >= 0) {
    if (afterBytes > stat.size) {
      const content = readFileSync(filePath, 'utf8');
      const all = content.split(/\r?\n/);
      return {
        path: filePath,
        lines: all.slice(-lines),
        size: stat.size,
        mtime: stat.mtimeMs,
        totalLines: all.length,
        appended: false,
        reset: true,
      };
    }
    const chunk = readNewBytes(filePath, afterBytes);
    const raw = chunk.text.replace(/\r/g, '');
    const parts = raw.split('\n');
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    return {
      path: filePath,
      lines: parts.filter((l, i) => !(i === 0 && l === '' && afterBytes > 0)),
      size: chunk.size,
      mtime: chunk.mtime,
      appended: true,
    };
  }
  const content = readFileSync(filePath, 'utf8');
  const all = content.split(/\r?\n/);
  return {
    path: filePath,
    lines: all.slice(-lines),
    size: stat.size,
    mtime: stat.mtimeMs,
    totalLines: all.length,
    appended: false,
  };
}

function readPid(name) {
  const path = join(DATA_DIR, `${name}.pid`);
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, 'utf8').trim());
  return Number.isFinite(pid) ? pid : null;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function maskPan(line) {
  const card = parseCardInput(String(line ?? '').replace(/\s+#.*$/, ''));
  if (!card?.number) return String(line ?? '');
  const pan = card.number.replace(/\D/g, '');
  const mm = String(card.expirationMonth ?? '').padStart(2, '0');
  const yyyy = String(card.expirationYear ?? '');
  return `${pan.slice(0, 6)}******${pan.slice(-4)}|${mm}|${yyyy}|***`;
}

function authToken(req) {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  return req.cookies?.admin_token || req.headers['x-admin-token'] || null;
}

function requireAuth(req, res, next) {
  const token = authToken(req);
  if (validateAdminSession(token)) {
    req.adminToken = token;
    return next();
  }
  return res.status(401).json({ error: 'Não autenticado' });
}

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    console.warn('[admin]', err.message);
    return fallback;
  }
}

async function proxyAutomation(path, opts = {}) {
  const url = `${AUTOMATION_URL}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export function startAdminServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.post('/api/login', (req, res) => {
    const password = String(req.body?.password ?? '');
    if (!ADMIN_PASSWORD) {
      return res.status(503).json({
        error: 'ADMIN_PASSWORD não configurado no .env',
      });
    }
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Senha incorreta' });
    }
    const session = createAdminSession();
    insertAudit('admin', 'login', 'session', { expiresAt: session.expiresAt });
    return res.json({ token: session.token, expiresAt: session.expiresAt });
  });

  app.post('/api/logout', requireAuth, (req, res) => {
    revokeAdminSession(req.adminToken);
    insertAudit('admin', 'logout');
    return res.json({ ok: true });
  });

  app.get('/api/me', requireAuth, (_req, res) => {
    res.json({ ok: true, dataDir: DATA_DIR });
  });

  app.get('/api/dashboard', requireAuth, async (_req, res) => {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let automation = null;
    try {
      const r = await proxyAutomation('/health');
      automation = r.body;
    } catch (err) {
      automation = { ok: false, error: err.message };
    }

    res.json({
      numbers: safeCall(
        () => ({
          total: countNumbers({ onlyOk: false }),
          ok: countNumbers({ onlyOk: true }),
          withValues: countWithValues(),
          errors: listErrors({ limit: 1 }).length ? 'has' : 0,
        }),
        { total: 0, ok: 0, withValues: 0, errors: 0 },
      ),
      cards: safeCall(
        () => ({
          pending: cardList.countPending(),
          approved: cardList.countApproved(),
          consumed: cardList.countConsumed(),
          inUse: cardList.countInUse(),
        }),
        { pending: 0, approved: 0, consumed: 0, inUse: 0 },
      ),
      users: safeCall(() => countTelegramUsers(), 0),
      recharges: safeCall(
        () => ({
          total: countRechargeEvents(),
          byStatus: countRechargeEventsByStatus(),
          last24h: rechargeStatsSince(dayAgo),
        }),
        { total: 0, byStatus: {}, last24h: {} },
      ),
      processes: {
        bot: { pid: readPid('bot'), alive: isAlive(readPid('bot')) },
        automation: { pid: readPid('automation'), alive: isAlive(readPid('automation')) },
        admin: { pid: process.pid, alive: true },
      },
      automation,
      proxy: describeProxy() || (proxyEnabled() ? 'ON' : 'OFF'),
      valueStock: safeCall(() => listValueStock().slice(0, 12), []),
      botPause: safeCall(() => getBotPauseState(), { paused: false }),
    });
  });

  app.get('/api/bot/pause', requireAuth, (_req, res) => {
    res.json(getBotPauseState());
  });

  app.patch('/api/bot/pause', requireAuth, (req, res) => {
    if (typeof req.body?.paused !== 'boolean') {
      return res.status(400).json({ error: 'paused (boolean) required' });
    }
    const state = setBotPaused(req.body.paused, {
      actor: 'admin',
      reason: req.body.reason ? String(req.body.reason).slice(0, 500) : null,
    });
    invalidateBotPauseCache();
    insertAudit('admin', req.body.paused ? 'bot_pause' : 'bot_resume', 'bot', state);
    res.json(state);
  });

  app.get('/api/numbers', requireAuth, (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const onlyOk = req.query.onlyOk !== '0';
    res.json({
      total: countNumbers({ onlyOk }),
      items: listNumbers({ limit, offset, onlyOk }),
    });
  });

  app.get('/api/numbers/:msisdn', requireAuth, (req, res) => {
    const row = getNumber(String(req.params.msisdn).replace(/\D/g, ''));
    if (!row) return res.status(404).json({ error: 'Não encontrado' });
    return res.json(row);
  });

  app.delete('/api/numbers/:msisdn', requireAuth, (req, res) => {
    const msisdn = String(req.params.msisdn).replace(/\D/g, '');
    const ok = deleteNumber(msisdn);
    if (ok) insertAudit('admin', 'delete_number', msisdn);
    res.json({ deleted: ok, msisdn });
  });

  app.get('/api/numbers-stock/values', requireAuth, (_req, res) => {
    res.json(listValueStock());
  });

  app.get('/api/cards', requireAuth, (req, res) => {
    const reveal = req.query.reveal === '1';
    const mapLine = (line) => (reveal ? line : maskPan(line));
    let reservations = [];
    try {
      if (existsSync(cardList.reservedPath)) {
        reservations = JSON.parse(readFileSync(cardList.reservedPath, 'utf8')).reservations ?? [];
      }
    } catch {
      reservations = [];
    }

    const pendingAll = cardList.loadPending();
    const approvedAll = cardList.loadApproved();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 80));
    res.json({
      pending: pendingAll.slice(0, limit).map(mapLine),
      approved: approvedAll.slice(-limit).map(mapLine),
      reserved: reservations.map((r) => ({
        chatId: r.chatId,
        reservedAt: r.reservedAt,
        pan: r.pan ? `****${String(r.pan).slice(-4)}` : null,
        line: reveal ? r.line : maskPan(r.line),
      })),
      counts: {
        pending: pendingAll.length,
        approved: approvedAll.length,
        inUse: cardList.countInUse(),
        pendingShown: Math.min(limit, pendingAll.length),
        approvedShown: Math.min(limit, approvedAll.length),
      },
    });
  });

  app.post('/api/cards/pending', requireAuth, async (req, res) => {
    const text = String(req.body?.text ?? '');
    if (!text.trim()) return res.status(400).json({ error: 'text vazio' });
    const stats = await cardList.ingestText(text);
    insertAudit('admin', 'cards_ingest', 'pending', stats);
    res.json(stats);
  });

  app.delete('/api/cards/pending', requireAuth, (_req, res) => {
    writeFileSync(cardList.pendingPath, '', 'utf8');
    insertAudit('admin', 'cards_clear', 'pending');
    res.json({ cleared: true });
  });

  function extrasFromRecharge(row) {
    let sessionId = null;
    let nsu = null;
    let auth = null;
    let brand = null;
    try {
      const raw = JSON.parse(row.raw_json || '{}');
      const outcome = raw?.outcome ?? {};
      sessionId = outcome.automation?.sessionId ?? null;
      const pay = outcome.automation?.raw?.gateResponse?.body?.payments?.[0];
      nsu = pay?.nsu ?? null;
      auth = pay?.authorizationCode ?? null;
      brand = pay?.card?.brand ?? null;
    } catch {
      // ignore
    }
    const { raw_json, ...safe } = row;
    return { ...safe, sessionId, nsu, auth, brand };
  }

  app.get('/api/recharges', requireAuth, (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const chatId = req.query.chatId || null;
    const items = listRechargeEvents({ limit, offset, chatId })
      .map(repairRechargeRow)
      .map(extrasFromRecharge);
    res.json({
      total: countRechargeEvents(),
      byStatus: countRechargeEventsByStatus(),
      items,
    });
  });

  app.get('/api/users', requireAuth, (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 100);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json({
      total: countTelegramUsers(),
      items: listTelegramUsers({ limit, offset }),
    });
  });

  app.get('/api/users/:chatId', requireAuth, (req, res) => {
    const user = getTelegramUser(req.params.chatId);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    return res.json(user);
  });

  app.patch('/api/users/:chatId', requireAuth, (req, res) => {
    const chatId = req.params.chatId;
    if (typeof req.body?.allowed === 'boolean') {
      setTelegramUserAllowed(chatId, req.body.allowed);
      insertAudit('admin', 'user_allowed', chatId, { allowed: req.body.allowed });
    }
    if (typeof req.body?.is_admin === 'boolean') {
      setTelegramUserAdmin(chatId, req.body.is_admin);
      insertAudit('admin', 'user_admin', chatId, { is_admin: req.body.is_admin });
    }
    res.json(getTelegramUser(chatId));
  });

  app.get('/api/logs/:name', requireAuth, (req, res) => {
    const name = req.params.name;
    const allowed = {
      bot: join(DATA_DIR, 'bot.log'),
      automation: join(DATA_DIR, 'automation.log'),
      admin: join(DATA_DIR, 'admin.log'),
    };
    const path = allowed[name];
    if (!path) return res.status(400).json({ error: 'Log inválido' });
    const lines = Math.min(2000, Number(req.query.lines) || 300);
    const afterRaw = req.query.afterBytes;
    const afterBytes = afterRaw != null && afterRaw !== '' ? Number(afterRaw) : null;
    res.json(tailFile(path, { lines, afterBytes }));
  });

  app.get('/api/audit', requireAuth, (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 100);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json({ items: listAudit({ limit, offset }) });
  });

  app.get('/api/config', requireAuth, (_req, res) => {
    const env = readEnvFile();
    const safe = { ...env };
    if (safe.TELEGRAM_BOT_TOKEN) {
      safe.TELEGRAM_BOT_TOKEN = `${safe.TELEGRAM_BOT_TOKEN.slice(0, 8)}…`;
    }
    if (safe.ADMIN_PASSWORD) safe.ADMIN_PASSWORD = '••••••••';
    res.json({ env: safe, path: envPath() });
  });

  app.patch('/api/config', requireAuth, (req, res) => {
    const updates = req.body?.env;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'env object required' });
    }
    const blocked = new Set(['TELEGRAM_BOT_TOKEN', 'ADMIN_PASSWORD']);
    const changed = [];
    for (const [key, value] of Object.entries(updates)) {
      if (blocked.has(key)) continue;
      if (value == null || value === '') continue;
      writeEnvKey(key, String(value));
      changed.push(key);
    }
    insertAudit('admin', 'config_update', 'env', { keys: changed });
    res.json({ updated: changed });
  });

  app.get('/api/system', requireAuth, (_req, res) => {
    const files = [];
    try {
      for (const f of readdirSync(DATA_DIR)) {
        const p = join(DATA_DIR, f);
        try {
          const s = statSync(p);
          if (s.isFile()) {
            files.push({ name: f, size: s.size, mtime: s.mtimeMs });
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    res.json({
      dataDir: DATA_DIR,
      processes: {
        bot: { pid: readPid('bot'), alive: isAlive(readPid('bot')) },
        automation: { pid: readPid('automation'), alive: isAlive(readPid('automation')) },
        admin: { pid: process.pid, alive: true },
      },
      files: files.sort((a, b) => b.mtime - a.mtime),
    });
  });

  app.post('/api/system/:action', requireAuth, (req, res) => {
    const action = req.params.action;
    const script = join(DATA_DIR, `${action}.sh`);
    const allowed = new Set(['run', 'stop', 'clear']);
    if (!allowed.has(action)) return res.status(400).json({ error: 'Ação inválida' });
    if (!existsSync(script)) return res.status(404).json({ error: `${action}.sh não encontrado` });
    try {
      const out = execSync(`bash ${script}`, { encoding: 'utf8', timeout: 30000 });
      insertAudit('admin', `system_${action}`, 'script', { out: out.slice(0, 500) });
      return res.json({ ok: true, output: out });
    } catch (err) {
      return res.status(500).json({ error: err.message, output: err.stdout || err.stderr });
    }
  });

  app.get('/api/automation/health', requireAuth, async (_req, res) => {
    try {
      const r = await proxyAutomation('/health');
      res.status(r.status).json(r.body);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  function sessionStepFromOutcome(s) {
    const pay = String(s.paymentStatus ?? s.status ?? s.paymentResult?.status ?? '').toLowerCase();
    const gate = String(s.gateCode ?? '').toUpperCase();
    const rawStep = `${s.step || ''} ${s.stepLabel || ''}`;
    const stuck = /aguardando_gate|aguardando retorno da gate/i.test(rawStep);
    const success = pay === 'success' || pay === 'done' || pay === 'confirmed' || gate === 'CONFIRMED';
    if (success && (stuck || !s.stepLabel)) {
      return { step: 'sucesso', stepLabel: s.gateMessage || 'Pagamento confirmado' };
    }
    if ((pay === '3ds' || pay === '3ds_required' || gate === '3DS') && (stuck || !s.stepLabel)) {
      return { step: '3ds_required', stepLabel: s.gateMessage || '3DS — confirme no banco' };
    }
    if ((pay === 'error' || pay === 'denied' || pay === 'error_manual') && (stuck || !s.stepLabel)) {
      return { step: 'erro_gate', stepLabel: s.gateMessage || s.lastError || 'Pagamento recusado' };
    }
    return { step: s.step ?? null, stepLabel: s.stepLabel ?? null };
  }

  function slimSession(s) {
    if (!s) return null;
    const pr = s.paymentResult;
    const body = pr?.gateResponse?.body;
    const pay = Array.isArray(body?.payments) ? body.payments[0] : null;
    const step = sessionStepFromOutcome(s);
    return {
      sessionId: s.sessionId ?? null,
      status: s.status ?? null,
      step: step.step,
      stepLabel: step.stepLabel,
      accessNumber: s.accessNumber ?? null,
      rechargeTargetNumber: s.rechargeTargetNumber ?? null,
      browserAlive: Boolean(s.browserAlive),
      createdAt: s.createdAt ?? null,
      closedAt: s.closedAt ?? null,
      lastError: s.lastError ?? null,
      paymentStatus: s.paymentStatus ?? pr?.status ?? null,
      gateCode: s.gateCode ?? pr?.gateCode ?? body?.status ?? null,
      gateMessage: s.gateMessage ?? pr?.gateMessage ?? pr?.message ?? null,
      nsu: s.nsu ?? pay?.nsu ?? null,
      username: s.username ?? null,
      productName: s.productName ?? null,
      fromHistory: Boolean(s.fromHistory),
    };
  }

  app.get('/api/automation/sessions', requireAuth, async (_req, res) => {
    let auto = { sessions: [], recent: [], aliveSessions: 0, maxConcurrentSessions: 3 };
    try {
      const r = await proxyAutomation('/api/sessions');
      if (r.body && typeof r.body === 'object') auto = { ...auto, ...r.body };
    } catch (err) {
      auto.error = err.message;
    }

    const live = (auto.sessions || []).map(slimSession).filter(Boolean);
    const liveIds = new Set(live.map((s) => s.sessionId).filter(Boolean));
    const recentAuto = (auto.recent || []).map(slimSession).filter(Boolean);

    let fromRecharges = [];
    try {
      fromRecharges = listRechargeEvents({ limit: 40 })
        .map(repairRechargeRow)
        .map((row) => {
          const extra = extrasFromRecharge(row);
          return slimSession({
            sessionId: extra.sessionId,
            status: extra.status,
            accessNumber: extra.login_msisdn,
            rechargeTargetNumber: extra.target_msisdn,
            browserAlive: false,
            createdAt: extra.created_at,
            paymentStatus: extra.status,
            gateCode: extra.gate_code,
            gateMessage: extra.gate_message,
            nsu: extra.nsu,
            username: extra.username,
            productName: extra.product_name,
            fromHistory: true,
          });
        })
        .filter((s) => s?.sessionId || s?.accessNumber);
    } catch (err) {
      console.warn('[admin] sessões/histórico:', err.message);
    }

    const recent = [];
    const seen = new Set(liveIds);
    for (const s of [...recentAuto, ...fromRecharges]) {
      const key = s.sessionId || `${s.accessNumber}:${s.createdAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      recent.push(s);
    }

    res.json({
      ok: !auto.error,
      error: auto.error ?? null,
      aliveSessions: auto.aliveSessions ?? live.length,
      pendingSlots: auto.pendingSlots ?? 0,
      maxConcurrentSessions: auto.maxConcurrentSessions ?? 3,
      sessions: live,
      recent: recent.slice(0, 40),
    });
  });

  app.post('/api/automation/sessions/:id/close', requireAuth, async (req, res) => {
    try {
      const r = await proxyAutomation(`/api/session/${req.params.id}/close`, { method: 'POST' });
      insertAudit('admin', 'close_session', req.params.id);
      res.status(r.status).json(r.body);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.use(
    '/assets',
    express.static(join(PUBLIC_DIR, 'assets'), {
      maxAge: 0,
      etag: false,
      lastModified: false,
    }),
  );

  const sendIndex = (_req, res) => {
    const index = join(PUBLIC_DIR, 'index.html');
    if (!existsSync(index)) return res.status(404).send('Admin UI não encontrada');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(index);
  };

  const spaPaths = [
    '/',
    '/dashboard',
    '/numeros',
    '/numbers',
    '/cartoes',
    '/cards',
    '/recargas',
    '/recharges',
    '/usuarios',
    '/users',
    '/sessoes',
    '/sessions',
    '/logs',
    '/config',
    '/sistema',
    '/system',
  ];
  for (const path of spaPaths) {
    app.get(path, sendIndex);
  }

  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/assets/')) return next();
    return sendIndex(req, res);
  });

  app.use((err, req, res, _next) => {
    console.error('[admin]', err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'erro interno' });
    }
  });

  try {
    const repaired = listRechargeEvents({ limit: 500 }).map(repairRechargeRow);
    const fixed = repaired.filter((r) => r?.status && r.status !== 'unknown').length;
    console.log(`[admin] histórico: ${repaired.length} recargas (${fixed} com status)`);
  } catch (err) {
    console.warn('[admin] repair histórico:', err.message);
  }

  try {
    const bf = backfillApprovedRecharges(cardList.loadApproved());
    if (bf.inserted) {
      console.log(`[admin] backfill aprovados → recargas: +${bf.inserted} (arquivo ${bf.approved})`);
    }
  } catch (err) {
    console.warn('[admin] backfill aprovados:', err.message);
  }

  app.listen(ADMIN_PORT, '0.0.0.0', () => {
    console.log(`[admin] painel em http://0.0.0.0:${ADMIN_PORT}`);
    if (!ADMIN_PASSWORD) {
      console.warn('[admin] AVISO: defina ADMIN_PASSWORD no .env');
    }
  });
}
