const TOKEN_KEY = 'linkclaro_admin_token';

const ROUTES = {
  '/': { view: 'dashboard', title: 'Dashboard' },
  '/dashboard': { view: 'dashboard', title: 'Dashboard' },
  '/numeros': { view: 'numbers', title: 'Números' },
  '/numbers': { view: 'numbers', title: 'Números' },
  '/cartoes': { view: 'cards', title: 'Cartões' },
  '/cards': { view: 'cards', title: 'Cartões' },
  '/recargas': { view: 'recharges', title: 'Recargas' },
  '/recharges': { view: 'recharges', title: 'Recargas' },
  '/usuarios': { view: 'users', title: 'Usuários Telegram' },
  '/users': { view: 'users', title: 'Usuários Telegram' },
  '/sessoes': { view: 'sessions', title: 'Sessões Edge' },
  '/sessions': { view: 'sessions', title: 'Sessões Edge' },
  '/logs': { view: 'logs', title: 'Logs' },
  '/config': { view: 'config', title: 'Configuração' },
  '/sistema': { view: 'system', title: 'Sistema' },
  '/system': { view: 'system', title: 'Sistema' },
};

const CANONICAL = {
  dashboard: '/',
  numbers: '/numeros',
  cards: '/cartoes',
  recharges: '/recargas',
  users: '/usuarios',
  sessions: '/sessoes',
  logs: '/logs',
  config: '/config',
  system: '/sistema',
};

let token = localStorage.getItem(TOKEN_KEY);
let currentView = 'dashboard';
let revealCards = false;
let logName = 'bot';
let rendering = false;
let logTimer = null;
let logBytes = 0;

const $ = (sel) => document.querySelector(sel);

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(Number(ms)).toLocaleString('pt-BR');
}

function fmtBRL(cents) {
  if (cents == null || cents === '') return '—';
  return `R$ ${(Number(cents) / 100).toFixed(2).replace('.', ',')}`;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 2800);
}

function closeMenu() {
  $('#sidebar')?.classList.remove('open');
  const overlay = $('#sidebar-overlay');
  if (overlay) overlay.hidden = true;
}

function openMenu() {
  $('#sidebar')?.classList.add('open');
  const overlay = $('#sidebar-overlay');
  if (overlay) overlay.hidden = false;
}

function parseRoute() {
  const raw = (location.pathname || '/').replace(/\/+$/, '') || '/';
  return ROUTES[raw] || ROUTES['/'];
}

function setActiveNav(path) {
  const canonical = CANONICAL[ROUTES[path]?.view] || path || '/';
  document.querySelectorAll('.nav-link').forEach((a) => {
    const href = a.getAttribute('data-route') || a.getAttribute('href');
    a.classList.toggle('active', href === canonical || href === path);
  });
}

function navigate(path, { replace = false } = {}) {
  const clean = path.startsWith('/') ? path : `/${path}`;
  const next = ROUTES[clean] ? clean : '/';
  if (location.pathname !== next) {
    history[replace ? 'replaceState' : 'pushState']({}, '', next);
  }
  closeMenu();
  renderView();
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${path}`, { ...opts, headers });
  if (res.status === 401) {
    logout(false);
    throw new Error('Sessão expirada. Entre de novo.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || 'Erro da API');
  return data;
}

function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

function showLogin() {
  $('#login-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');
  closeMenu();
}

function logout(callApi = true) {
  stopLogLive();
  stopSessionLive();
  if (callApi && token) {
    api('/logout', { method: 'POST' }).catch(() => {});
  }
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
}

function badge(status) {
  const s = String(status || '—').toLowerCase();
  const label = {
    success: 'aprovada',
    ok: 'ok',
    done: 'ok',
    confirmed: 'aprovada',
    denied: 'negada',
    error: 'erro',
    fail: 'falha',
    timeout: 'timeout',
    '3ds': '3DS',
    '3ds_required': '3DS',
    unknown: 'indefinido',
    offline: 'offline',
    bloqueado: 'bloqueado',
  }[s] || s;
  const cls = ['success', 'ok', 'done', 'confirmed'].includes(s) ? 'ok'
    : ['error', 'fail', 'denied', 'offline', 'bloqueado'].includes(s) ? 'err'
      : 'warn';
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function productLabel(r) {
  const name = String(r.product_name || '').trim();
  if (/r\$/i.test(name)) return name;
  if (r.product_value_cents != null) return name ? `${name} · ${fmtBRL(r.product_value_cents)}` : fmtBRL(r.product_value_cents);
  return name || '—';
}

function fmtDuration(ms) {
  if (ms == null || ms === '') return '—';
  const n = Number(ms);
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',')}s`;
}

function tableWrap(inner, compact = false) {
  return `<div class="table-wrap"><table class="${compact ? 'compact' : ''}">${inner}</table></div>`;
}

async function viewDashboard() {
  const d = await api('/dashboard');
  const r24 = Object.entries(d.recharges?.last24h || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ') || '0';
  const stock = (d.valueStock || [])
    .map((v) => `<tr><td>${esc(v.name || fmtBRL(v.value))}</td><td>${v.count}</td></tr>`)
    .join('') || '<tr><td colspan="2" class="empty">Sem estoque</td></tr>';
  return `
    <div class="grid">
      <div class="stat"><div class="label">Números OK</div><div class="value">${d.numbers.ok}</div><div class="sub">total ${d.numbers.total}</div></div>
      <div class="stat"><div class="label">Com valores</div><div class="value">${d.numbers.withValues}</div></div>
      <div class="stat"><div class="label">Cartões na fila</div><div class="value">${d.cards.pending}</div><div class="sub">aprovados ${d.cards.approved} · uso ${d.cards.inUse}</div></div>
      <div class="stat"><div class="label">Usuários TG</div><div class="value">${d.users}</div></div>
      <div class="stat"><div class="label">Recargas</div><div class="value">${d.recharges.total}</div><div class="sub">24h: ${esc(r24)}</div></div>
      <div class="stat"><div class="label">Proxy</div><div class="value" style="font-size:1rem">${esc(d.proxy)}</div></div>
    </div>
    <div class="panel">
      <h3>Processos</h3>
      ${tableWrap(`
        <tr><th>Serviço</th><th>PID</th><th>Status</th></tr>
        <tr><td>Bot Telegram</td><td>${d.processes.bot.pid ?? '—'}</td><td>${badge(d.processes.bot.alive ? 'ok' : 'offline')}</td></tr>
        <tr><td>Automação Edge</td><td>${d.processes.automation.pid ?? '—'}</td><td>${badge(d.processes.automation.alive ? 'ok' : 'offline')}</td></tr>
        <tr><td>Admin</td><td>${d.processes.admin.pid}</td><td>${badge('ok')}</td></tr>
      `, true)}
    </div>
    <div class="panel">
      <h3>Estoque por valor</h3>
      ${tableWrap(`<tr><th>Valor</th><th>Qtd</th></tr>${stock}`, true)}
    </div>
    <div class="panel">
      <h3>Automação</h3>
      <pre class="mono">${esc(JSON.stringify(d.automation, null, 2))}</pre>
    </div>`;
}

function numberRow(n) {
  const vals = (n.valores || []).map((v) => v.name || fmtBRL(v.value)).join(', ') || '—';
  return `<tr>
    <td class="mono">${esc(n.msisdn)}</td>
    <td>${badge(n.status)}</td>
    <td>${esc(vals)}</td>
    <td>${fmtDate(n.scannedAt)}</td>
    <td><button type="button" class="btn small danger" data-action="delete-number" data-msisdn="${esc(n.msisdn)}">Apagar</button></td>
  </tr>`;
}

async function viewNumbers() {
  const data = await api('/numbers?limit=80&offset=0');
  return `
    <div class="panel">
      <h3>Números no banco (${data.total})</h3>
      ${tableWrap(`
        <thead><tr><th>MSISDN</th><th>Status</th><th>Valores</th><th>Scan</th><th></th></tr></thead>
        <tbody id="numbers-tbody">${data.items.map(numberRow).join('')}</tbody>
      `)}
      ${data.items.length < data.total
        ? `<div class="toolbar" style="margin-top:0.75rem"><button type="button" class="btn secondary" data-action="numbers-more" data-offset="${data.items.length}" data-total="${data.total}">Carregar mais</button></div>`
        : ''}
    </div>`;
}

async function viewCards() {
  const data = await api(`/cards?reveal=${revealCards ? '1' : '0'}`);
  const list = (lines) => lines.length
    ? `<ul class="card-list mono">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
    : '<p class="empty">Vazio</p>';
  return `
    <div class="toolbar">
      <button type="button" class="btn secondary" data-action="cards-reveal">${revealCards ? 'Ocultar PAN' : 'Mostrar PAN'}</button>
      <button type="button" class="btn danger" data-action="cards-clear">Limpar fila</button>
    </div>
    <div class="grid">
      <div class="stat"><div class="label">Pendentes</div><div class="value">${data.counts.pending}</div></div>
      <div class="stat"><div class="label">Aprovados</div><div class="value">${data.counts.approved}</div></div>
      <div class="stat"><div class="label">Em uso</div><div class="value">${data.counts.inUse}</div></div>
    </div>
    <div class="panel">
      <h3>Adicionar cartões</h3>
      <form data-action="cards-ingest">
        <textarea id="cards-text" placeholder="PAN|MES|ANO|CVV (um por linha)"></textarea>
        <button type="submit" class="btn" style="margin-top:0.6rem">Importar</button>
      </form>
    </div>
    <div class="panel"><h3>Fila pendente (${data.counts.pendingShown ?? data.pending.length}/${data.counts.pending})</h3>${list(data.pending)}</div>
    <div class="panel"><h3>Aprovados (${data.counts.approvedShown ?? data.approved.length}/${data.counts.approved})</h3>${list(data.approved)}</div>
    <div class="panel">
      <h3>Reservados</h3>
      ${data.reserved.length ? tableWrap(`
        <tr><th>Cartão</th><th>Chat</th><th>Desde</th></tr>
        ${data.reserved.map((r) => `<tr><td class="mono">${esc(r.line)}</td><td>${esc(r.chatId)}</td><td>${fmtDate(r.reservedAt)}</td></tr>`).join('')}
      `) : '<p class="empty">Nenhum</p>'}
    </div>`;
}

function rechargeCard(r) {
  const dest = r.target_msisdn && r.target_msisdn !== r.login_msisdn
    ? `${r.login_msisdn} → ${r.target_msisdn}`
    : (r.login_msisdn || '—');
  const meta = [
    r.brand ? r.brand : null,
    r.card_last4 ? `****${r.card_last4}` : null,
    r.nsu ? `NSU ${r.nsu}` : null,
    r.auth ? `AUTH ${r.auth}` : null,
    r.mode ? r.mode : null,
  ].filter(Boolean).join(' · ');
  return `<article class="hist-card">
    <div class="hist-top">
      ${badge(r.status)}
      <strong>${esc(productLabel(r))}</strong>
      <span class="muted">${fmtDate(r.created_at)} · ${fmtDuration(r.duration_ms)}</span>
    </div>
    <div class="hist-grid">
      <div><span class="label">Usuário</span><b>@${esc(r.username || r.chat_id || '—')}</b></div>
      <div><span class="label">Números</span><b class="mono">${esc(dest)}</b></div>
      <div><span class="label">Gate</span><b>${esc(r.gate_code || '—')}</b></div>
    </div>
    <p class="hist-msg">${esc(r.gate_message || '')}</p>
    ${meta ? `<p class="muted">${esc(meta)}</p>` : ''}
  </article>`;
}

async function viewRecharges() {
  const data = await api('/recharges?limit=80');
  const cards = data.items.length
    ? data.items.map(rechargeCard).join('')
    : '<p class="empty">Sem recargas ainda</p>';
  return `
    <div class="panel">
      <h3>Histórico de recargas (${data.total})</h3>
      <div class="hist-list">${cards}</div>
    </div>`;
}

async function viewUsers() {
  const data = await api('/users?limit=100');
  const rows = data.items.length
    ? data.items.map((u) => `<tr>
        <td class="mono">${esc(u.chat_id)}</td>
        <td>@${esc(u.username || '—')}</td>
        <td>${esc([u.first_name, u.last_name].filter(Boolean).join(' '))}</td>
        <td>${u.message_count}</td>
        <td>${fmtDate(u.last_seen)}</td>
        <td>${badge(u.allowed ? 'ok' : 'bloqueado')}</td>
        <td>
          ${u.allowed
            ? `<button type="button" class="btn small danger" data-action="toggle-user" data-chat-id="${esc(u.chat_id)}" data-allowed="0">Bloquear</button>`
            : `<button type="button" class="btn small" data-action="toggle-user" data-chat-id="${esc(u.chat_id)}" data-allowed="1">Liberar</button>`}
        </td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="empty">Nenhum usuário ainda — o bot passa a registrar a partir desta versão</td></tr>';
  return `
    <div class="panel">
      <h3>Usuários Telegram (${data.total})</h3>
      ${tableWrap(`
        <thead><tr><th>Chat ID</th><th>Username</th><th>Nome</th><th>Msgs</th><th>Último acesso</th><th>Acesso</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      `)}
    </div>`;
}

function sessionCard(s, { live = false } = {}) {
  const dest = s.rechargeTargetNumber && s.rechargeTargetNumber !== s.accessNumber
    ? `${s.accessNumber} → ${s.rechargeTargetNumber}`
    : (s.accessNumber || '—');
  const closeBtn = live && s.sessionId
    ? `<button type="button" class="btn small danger" data-action="close-session" data-id="${esc(s.sessionId)}">Fechar Edge</button>`
    : '';
  return `<article class="hist-card">
    <div class="hist-top">
      ${badge(s.paymentStatus || s.status || '—')}
      ${badge(s.browserAlive ? 'ok' : 'offline')}
      <span class="muted">${fmtDate(s.createdAt)}</span>
      ${closeBtn}
    </div>
    <div class="hist-grid">
      <div><span class="label">Número</span><b class="mono">${esc(dest)}</b></div>
      <div><span class="label">Passo</span><b>${esc(s.stepLabel || s.step || '—')}</b></div>
      <div><span class="label">Gate</span><b>${esc(s.gateCode || '—')}</b></div>
    </div>
    ${s.username || s.productName ? `<p class="muted">${esc([s.username && '@'+s.username, s.productName, s.nsu && 'NSU '+s.nsu].filter(Boolean).join(' · '))}</p>` : ''}
    ${s.gateMessage || s.lastError ? `<p class="hist-msg">${esc(s.gateMessage || s.lastError)}</p>` : ''}
  </article>`;
}

function renderSessionsBody(data) {
  const live = data.sessions || [];
  const recent = data.recent || [];
  return `
    <div class="panel">
      <h3>Ao vivo (${data.aliveSessions ?? live.length}/${data.maxConcurrentSessions ?? '?'})</h3>
      <div id="sessions-live">${live.length ? live.map((s) => sessionCard(s, { live: true })).join('') : '<p class="empty">Nenhum Edge aberto agora — as recargas recentes ficam abaixo</p>'}</div>
    </div>
    <div class="panel">
      <h3>Sessões recentes (${recent.length})</h3>
      <div id="sessions-recent">${recent.length ? recent.map((s) => sessionCard(s)).join('') : '<p class="empty">Ainda sem histórico de Edge</p>'}</div>
    </div>`;
}

let sessionTimer = null;

function stopSessionLive() {
  if (sessionTimer) {
    clearInterval(sessionTimer);
    sessionTimer = null;
  }
}

function startSessionLive() {
  stopSessionLive();
  sessionTimer = setInterval(async () => {
    if (currentView !== 'sessions' || !token) {
      stopSessionLive();
      return;
    }
    try {
      const data = await api('/automation/sessions');
      const live = $('#sessions-live');
      const recent = $('#sessions-recent');
      if (live) {
        live.innerHTML = (data.sessions || []).length
          ? data.sessions.map((s) => sessionCard(s, { live: true })).join('')
          : '<p class="empty">Nenhum Edge aberto agora — as recargas recentes ficam abaixo</p>';
      }
      if (recent) {
        recent.innerHTML = (data.recent || []).length
          ? data.recent.map((s) => sessionCard(s)).join('')
          : '<p class="empty">Ainda sem histórico de Edge</p>';
      }
      $('#status-dot').className = 'status-dot ok';
    } catch (err) {
      $('#status-dot').className = 'status-dot err';
    }
  }, 2000);
}

async function viewSessions() {
  try {
    const data = await api('/automation/sessions');
    return renderSessionsBody(data);
  } catch (err) {
    return `<div class="panel"><p class="error">Automação offline: ${esc(err.message)}</p></div>`;
  }
}

function stopLogLive() {
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }
}

function startLogLive() {
  stopLogLive();
  logTimer = setInterval(async () => {
    if (currentView !== 'logs' || !token) {
      stopLogLive();
      return;
    }
    const output = $('#log-output');
    const meta = $('#log-meta');
    if (!output) return;
    try {
      const data = await api(`/logs/${logName}?afterBytes=${logBytes}&lines=200`);
      if (data.reset || !data.appended) {
        output.textContent = (data.lines || []).join('\n') || '(vazio)';
        output.scrollTop = output.scrollHeight;
      } else if (data.lines?.length) {
        const chunk = data.lines.join('\n');
        output.textContent = output.textContent
          ? `${output.textContent}\n${chunk}`
          : chunk;
        output.scrollTop = output.scrollHeight;
      }
      logBytes = data.size ?? logBytes;
      if (meta) {
        meta.textContent = `ao vivo · ${Math.round((logBytes || 0) / 1024)} KB`;
      }
      $('#status-dot').className = 'status-dot ok';
    } catch (err) {
      if (meta) meta.textContent = `log: ${err.message}`;
      $('#status-dot').className = 'status-dot err';
    }
  }, 1500);
}

async function viewLogs() {
  const data = await api(`/logs/${logName}?lines=400`);
  logBytes = data.size || 0;
  const tabs = ['bot', 'automation', 'admin']
    .map((n) => `<button type="button" class="tab ${n === logName ? 'active' : ''}" data-action="log-tab" data-log="${n}">${n === 'automation' ? 'Automação' : n[0].toUpperCase() + n.slice(1)}</button>`)
    .join('');
  return `
    <div class="tabs">${tabs}</div>
    <div class="log-view" id="log-output">${esc((data.lines || []).join('\n') || '(vazio)')}</div>
    <p class="sub" id="log-meta" style="margin-top:0.5rem;color:var(--muted)">ao vivo · ${data.totalLines ?? (data.lines || []).length} linhas · ${Math.round((data.size || 0) / 1024)} KB</p>`;
}

async function viewConfig() {
  const data = await api('/config');
  const keys = [
    'HEADLESS', 'BROWSER_NAME', 'RECHARGE_MODE', 'RECHARGE_BROWSER_FLOW',
    'PROXY_ENABLED', 'PROXY_ROTATE', 'PROXY_LOG_IP',
    'THREEDS_CONTINUE_GATE_WAIT', 'THREEDS_UI_WAIT_MS', 'THREEDS_EXTRA_WAIT_MS',
    'MAX_CONCURRENT_SESSIONS', 'CHECKOUT_LINK_FAST', 'CHECKOUT_LINK_HTTP_GATE',
    'AUTOMATION_API_URL', 'ADMIN_PORT',
  ];
  return `
    <div class="panel">
      <h3>Variáveis (.env)</h3>
      <p style="color:var(--muted);margin-bottom:0.75rem;font-size:0.85rem">${esc(data.path)}</p>
      <form data-action="config-save">
        ${keys.map((k) => `
          <div class="form-row">
            <label for="env-${k}">${esc(k)}</label>
            <input id="env-${k}" data-env-key="${esc(k)}" value="${esc(data.env[k] ?? '')}">
          </div>`).join('')}
        <button type="submit" class="btn">Salvar alterações</button>
      </form>
      <p style="color:var(--muted);margin-top:0.75rem;font-size:0.8rem">Token e senha admin não são editáveis aqui. Reinicie os serviços após mudanças.</p>
    </div>`;
}

async function viewSystem() {
  const data = await api('/system');
  return `
    <div class="toolbar">
      <button type="button" class="btn" data-action="system" data-cmd="run">Iniciar (run.sh)</button>
      <button type="button" class="btn secondary" data-action="system" data-cmd="stop">Parar (stop.sh)</button>
      <button type="button" class="btn danger" data-action="system" data-cmd="clear">Limpar logs</button>
    </div>
    <div class="panel">
      <h3>Diretório de dados</h3>
      <p class="mono">${esc(data.dataDir)}</p>
    </div>
    <div class="panel">
      <h3>Arquivos</h3>
      ${tableWrap(`
        <tr><th>Arquivo</th><th>Tamanho</th><th>Modificado</th></tr>
        ${(data.files || []).map((f) => `<tr><td>${esc(f.name)}</td><td>${Math.round(f.size / 1024)} KB</td><td>${fmtDate(f.mtime)}</td></tr>`).join('')}
      `, true)}
    </div>`;
}

const VIEWS = {
  dashboard: viewDashboard,
  numbers: viewNumbers,
  cards: viewCards,
  recharges: viewRecharges,
  users: viewUsers,
  sessions: viewSessions,
  logs: viewLogs,
  config: viewConfig,
  system: viewSystem,
};

async function renderView() {
  if (!token) {
    showLogin();
    return;
  }
  if (rendering) return;
  rendering = true;
  stopLogLive();
  stopSessionLive();
  const route = parseRoute();
  currentView = route.view;
  $('#view-title').textContent = route.title;
  setActiveNav(location.pathname.replace(/\/+$/, '') || '/');
  const el = $('#content');
  el.innerHTML = '<p class="empty">Carregando…</p>';
  try {
    el.innerHTML = await VIEWS[currentView]();
    $('#status-dot').className = 'status-dot ok';
    if (currentView === 'logs') {
      const output = $('#log-output');
      if (output) output.scrollTop = output.scrollHeight;
      startLogLive();
    }
    if (currentView === 'sessions') startSessionLive();
  } catch (err) {
    el.innerHTML = `<div class="panel"><p class="error">${esc(err.message)}</p></div>`;
    $('#status-dot').className = 'status-dot err';
  } finally {
    rendering = false;
  }
}

async function onContentClick(e) {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.action;

  if (action === 'delete-number') {
    if (!confirm(`Apagar ${actionEl.dataset.msisdn}?`)) return;
    await api(`/numbers/${actionEl.dataset.msisdn}`, { method: 'DELETE' });
    toast('Número apagado');
    return renderView();
  }

  if (action === 'numbers-more') {
    const offset = Number(actionEl.dataset.offset);
    const total = Number(actionEl.dataset.total);
    const data = await api(`/numbers?limit=80&offset=${offset}`);
    const tbody = $('#numbers-tbody');
    tbody.insertAdjacentHTML('beforeend', data.items.map(numberRow).join(''));
    const next = offset + data.items.length;
    actionEl.dataset.offset = String(next);
    if (next >= total || !data.items.length) actionEl.remove();
    return;
  }

  if (action === 'cards-reveal') {
    revealCards = !revealCards;
    return renderView();
  }

  if (action === 'cards-clear') {
    if (!confirm('Limpar fila de cartões pendentes?')) return;
    await api('/cards/pending', { method: 'DELETE' });
    toast('Fila limpa');
    return renderView();
  }

  if (action === 'toggle-user') {
    await api(`/users/${actionEl.dataset.chatId}`, {
      method: 'PATCH',
      body: JSON.stringify({ allowed: actionEl.dataset.allowed === '1' }),
    });
    toast(actionEl.dataset.allowed === '1' ? 'Usuário liberado' : 'Usuário bloqueado');
    return renderView();
  }

  if (action === 'close-session') {
    await api(`/automation/sessions/${actionEl.dataset.id}/close`, { method: 'POST' });
    toast('Sessão fechada');
    return renderView();
  }

  if (action === 'log-tab') {
    logName = actionEl.dataset.log;
    return renderView();
  }

  if (action === 'system') {
    if (!confirm(`Executar ${actionEl.dataset.cmd}.sh?`)) return;
    try {
      const r = await api(`/system/${actionEl.dataset.cmd}`, { method: 'POST' });
      toast((r.output || 'OK').slice(0, 180));
      return renderView();
    } catch (err) {
      toast(err.message);
    }
  }
}

async function onContentSubmit(e) {
  const form = e.target.closest('form[data-action]');
  if (!form) return;
  e.preventDefault();
  if (form.dataset.action === 'cards-ingest') {
    const text = $('#cards-text')?.value || '';
    try {
      const r = await api('/cards/pending', { method: 'POST', body: JSON.stringify({ text }) });
      toast(`Adicionados: ${r.added} · Duplicados: ${r.duplicates} · Inválidos: ${r.invalid}`);
      renderView();
    } catch (err) {
      toast(err.message);
    }
  }
  if (form.dataset.action === 'config-save') {
    const env = {};
    form.querySelectorAll('[data-env-key]').forEach((input) => {
      if (input.value.trim()) env[input.dataset.envKey] = input.value.trim();
    });
    try {
      const r = await api('/config', { method: 'PATCH', body: JSON.stringify({ env }) });
      toast(`Atualizado: ${r.updated.join(', ') || 'nada'}`);
    } catch (err) {
      toast(err.message);
    }
  }
}

function bootUi() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('#login-password').value;
    $('#login-error').textContent = '';
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Falha no login');
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      showApp();
      renderView();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  $('#logout-btn').addEventListener('click', () => logout(true));
  $('#refresh-btn').addEventListener('click', () => renderView());
  $('#menu-btn').addEventListener('click', () => {
    if ($('#sidebar').classList.contains('open')) closeMenu();
    else openMenu();
  });
  $('#sidebar-overlay').addEventListener('click', closeMenu);

  document.querySelectorAll('.nav-link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(a.getAttribute('data-route') || a.getAttribute('href'));
    });
  });

  window.addEventListener('popstate', () => renderView());

  $('#content').addEventListener('click', (e) => {
    onContentClick(e).catch((err) => toast(err.message));
  });
  $('#content').addEventListener('submit', onContentSubmit);
}

async function start() {
  bootUi();
  if (token) {
    try {
      await api('/me');
      showApp();
      renderView();
    } catch {
      showLogin();
    }
  } else {
    showLogin();
  }
}

start();
