import express from 'express';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
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
  listRechargeEvents,
  countRechargeEvents,
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
  countForValue,
} from '../lib/numbers-db.mjs';
import { createCardListStore } from '../lib/card-list.mjs';
import { parseCardInput } from '../lib/card-parse.mjs';
import { describeProxy, proxyEnabled } from '../lib/proxy.mjs';

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

function tailFile(filePath, lines = 200) {
  if (!existsSync(filePath)) return { path: filePath, lines: [], size: 0, mtime: null };
  const stat = statSync(filePath);
  const content = readFileSync(filePath, 'utf8');
  const all = content.split(/\r?\n/);
  return {
    path: filePath,
    lines: all.slice(-lines),
    size: stat.size,
    mtime: stat.mtimeMs,
    totalLines: all.length,
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
  if (!card?.number) return line;
  const pan = card.number.replace(/\D/g, '');
  return `${pan.slice(0, 6)}******${pan.slice(-4)}|${card.expMonth}|${card.expYear}|***`;
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

async function proxyAutomation(path, opts = {}) {
  const url = `${AUTOMATION_URL}${path}`;
  const res = await fetch(url, {
    ...opts,
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
      numbers: {
        total: countNumbers({ onlyOk: false }),
        ok: countNumbers({ onlyOk: true }),
        withValues: countWithValues(),
        errors: listErrors({ limit: 1 }).length ? 'has' : 0,
      },
      cards: {
        pending: cardList.countPending(),
        approved: cardList.countApproved(),
        inUse: cardList.countInUse(),
      },
      users: countTelegramUsers(),
      recharges: {
        total: countRechargeEvents(),
        last24h: rechargeStatsSince(dayAgo),
      },
      processes: {
        bot: { pid: readPid('bot'), alive: isAlive(readPid('bot')) },
        automation: { pid: readPid('automation'), alive: isAlive(readPid('automation')) },
        admin: { pid: process.pid, alive: true },
      },
      automation,
      proxy: describeProxy() || (proxyEnabled() ? 'ON' : 'OFF'),
      valueStock: listValueStock().slice(0, 12),
    });
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

    res.json({
      pending: cardList.loadPending().map(mapLine),
      approved: cardList.loadApproved().map(mapLine),
      reserved: reservations.map((r) => ({
        ...r,
        line: reveal ? r.line : maskPan(r.line),
      })),
      counts: {
        pending: cardList.countPending(),
        approved: cardList.countApproved(),
        inUse: cardList.countInUse(),
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

  app.get('/api/recharges', requireAuth, (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const chatId = req.query.chatId || null;
    res.json({
      total: countRechargeEvents(),
      items: listRechargeEvents({ limit, offset, chatId }),
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
    res.json(tailFile(path, lines));
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

  app.get('/api/automation/sessions', requireAuth, async (_req, res) => {
    try {
      const r = await proxyAutomation('/api/sessions');
      res.status(r.status).json(r.body);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
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

  app.use(express.static(PUBLIC_DIR));
  app.get('*', (_req, res) => {
    const index = join(PUBLIC_DIR, 'index.html');
    if (existsSync(index)) return res.sendFile(index);
    return res.status(404).send('Admin UI não encontrada');
  });

  app.listen(ADMIN_PORT, '0.0.0.0', () => {
    console.log(`[admin] painel em http://0.0.0.0:${ADMIN_PORT}`);
    if (!ADMIN_PASSWORD) {
      console.warn('[admin] AVISO: defina ADMIN_PASSWORD no .env');
    }
  });
}
