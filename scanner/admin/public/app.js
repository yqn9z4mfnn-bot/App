const TOKEN_KEY = 'linkclaro_admin_token';
let token = localStorage.getItem(TOKEN_KEY);
let currentView = 'dashboard';
let revealCards = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('pt-BR');
}

function fmtBRL(cents) {
  if (cents == null) return '—';
  return `R$ ${(Number(cents) / 100).toFixed(2).replace('.', ',')}`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${path}`, { ...opts, headers });
  if (res.status === 401) {
    logout();
    throw new Error('Sessão expirada');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

function showLogin() {
  $('#login-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');
}

function logout() {
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
}

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

$('#logout-btn').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ }
  logout();
});

$('#refresh-btn').addEventListener('click', () => renderView());

$$('.nav').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentView = btn.dataset.view;
    $$('.nav').forEach((n) => n.classList.toggle('active', n === btn));
    renderView();
  });
});

const titles = {
  dashboard: 'Dashboard',
  numbers: 'Números',
  cards: 'Cartões',
  recharges: 'Recargas',
  users: 'Usuários Telegram',
  sessions: 'Sessões Edge',
  logs: 'Logs',
  config: 'Configuração',
  system: 'Sistema',
};

async function renderView() {
  $('#view-title').textContent = titles[currentView] || currentView;
  const el = $('#content');
  el.innerHTML = '<p class="empty">Carregando…</p>';
  try {
    if (currentView === 'dashboard') el.innerHTML = await viewDashboard();
    else if (currentView === 'numbers') el.innerHTML = await viewNumbers();
    else if (currentView === 'cards') el.innerHTML = await viewCards();
    else if (currentView === 'recharges') el.innerHTML = await viewRecharges();
    else if (currentView === 'users') el.innerHTML = await viewUsers();
    else if (currentView === 'sessions') el.innerHTML = await viewSessions();
    else if (currentView === 'logs') el.innerHTML = await viewLogs();
    else if (currentView === 'config') el.innerHTML = await viewConfig();
    else if (currentView === 'system') el.innerHTML = await viewSystem();
    bindViewEvents();
    $('#status-dot').className = 'status-dot ok';
  } catch (err) {
    el.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    $('#status-dot').className = 'status-dot err';
  }
}

function bindViewEvents() {
  const el = $('#content');

  el.querySelector('#cards-reveal')?.addEventListener('click', () => {
    revealCards = !revealCards;
    renderView();
  });

  el.querySelector('#cards-ingest-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = el.querySelector('#cards-text').value;
    try {
      const r = await api('/cards/pending', { method: 'POST', body: JSON.stringify({ text }) });
      alert(`Adicionados: ${r.added} · Duplicados: ${r.duplicates} · Inválidos: ${r.invalid}`);
      renderView();
    } catch (err) { alert(err.message); }
  });

  el.querySelector('#cards-clear')?.addEventListener('click', async () => {
    if (!confirm('Limpar fila de cartões pendentes?')) return;
    await api('/cards/pending', { method: 'DELETE' });
    renderView();
  });

  el.querySelectorAll('[data-delete-number]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Apagar ${btn.dataset.deleteNumber}?`)) return;
      await api(`/numbers/${btn.dataset.deleteNumber}`, { method: 'DELETE' });
      renderView();
    });
  });

  el.querySelectorAll('[data-toggle-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const allowed = btn.dataset.toggleUser === '1';
      await api(`/users/${btn.dataset.chatId}`, {
        method: 'PATCH',
        body: JSON.stringify({ allowed }),
      });
      renderView();
    });
  });

  el.querySelectorAll('[data-close-session]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/automation/sessions/${btn.dataset.closeSession}/close`, { method: 'POST' });
      renderView();
    });
  });

  el.querySelectorAll('.log-tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      el.querySelectorAll('.log-tab').forEach((t) => t.classList.toggle('active', t === tab));
      const name = tab.dataset.log;
      const data = await api(`/logs/${name}?lines=400`);
      el.querySelector('#log-output').textContent = data.lines.join('\n') || '(vazio)';
    });
  });

  el.querySelector('#config-save')?.addEventListener('click', async () => {
    const env = {};
    el.querySelectorAll('[data-env-key]').forEach((input) => {
      if (input.value.trim()) env[input.dataset.envKey] = input.value.trim();
    });
    const r = await api('/config', { method: 'PATCH', body: JSON.stringify({ env }) });
    alert(`Atualizado: ${r.updated.join(', ') || 'nada'}`);
    renderView();
  });

  el.querySelectorAll('[data-system-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Executar ${btn.dataset.systemAction}.sh?`)) return;
      try {
        const r = await api(`/system/${btn.dataset.systemAction}`, { method: 'POST' });
        alert(r.output || 'OK');
        renderView();
      } catch (err) { alert(err.message); }
    });
  });

  el.querySelector('#numbers-more')?.addEventListener('click', async () => {
    const offset = Number(el.querySelector('#numbers-more').dataset.offset);
    const data = await api(`/numbers?limit=50&offset=${offset}`);
    const tbody = el.querySelector('#numbers-tbody');
    for (const n of data.items) {
      tbody.insertAdjacentHTML('beforeend', numberRow(n));
    }
    el.querySelector('#numbers-more').dataset.offset = offset + data.items.length;
    if (offset + data.items.length >= data.total) el.querySelector('#numbers-more').remove();
    bindViewEvents();
  });
}

function numberRow(n) {
  const vals = (n.valores || []).map((v) => v.name || fmtBRL(v.value)).join(', ') || '—';
  return `<tr>
    <td class="mono">${esc(n.msisdn)}</td>
    <td><span class="badge ${n.status === 'ok' ? 'ok' : n.status === 'error' ? 'err' : 'warn'}">${esc(n.status)}</span></td>
    <td>${esc(vals)}</td>
    <td>${fmtDate(n.scannedAt)}</td>
    <td><button class="btn small danger" data-delete-number="${esc(n.msisdn)}">Apagar</button></td>
  </tr>`;
}

async function viewDashboard() {
  const d = await api('/dashboard');
  const r24 = Object.entries(d.recharges.last24h || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || '0';
  return `
    <div class="grid">
      <div class="card"><div class="label">Números OK</div><div class="value">${d.numbers.ok}</div><div class="sub">total ${d.numbers.total}</div></div>
      <div class="card"><div class="label">Com valores</div><div class="value">${d.numbers.withValues}</div></div>
      <div class="card"><div class="label">Cartões fila</div><div class="value">${d.cards.pending}</div><div class="sub">aprovados ${d.cards.approved} · uso ${d.cards.inUse}</div></div>
      <div class="card"><div class="label">Usuários TG</div><div class="value">${d.users}</div></div>
      <div class="card"><div class="label">Recargas</div><div class="value">${d.recharges.total}</div><div class="sub">24h: ${esc(r24)}</div></div>
      <div class="card"><div class="label">Proxy</div><div class="value" style="font-size:1rem">${esc(d.proxy)}</div></div>
    </div>
    <div class="panel">
      <h3>Processos</h3>
      <table>
        <tr><th>Serviço</th><th>PID</th><th>Status</th></tr>
        <tr><td>Bot Telegram</td><td>${d.processes.bot.pid ?? '—'}</td><td><span class="badge ${d.processes.bot.alive ? 'ok' : 'err'}">${d.processes.bot.alive ? 'online' : 'offline'}</span></td></tr>
        <tr><td>Automação Edge</td><td>${d.processes.automation.pid ?? '—'}</td><td><span class="badge ${d.processes.automation.alive ? 'ok' : 'err'}">${d.processes.automation.alive ? 'online' : 'offline'}</span></td></tr>
        <tr><td>Admin</td><td>${d.processes.admin.pid}</td><td><span class="badge ok">online</span></td></tr>
      </table>
    </div>
    <div class="panel">
      <h3>Estoque por valor</h3>
      <table>
        <tr><th>Valor</th><th>Qtd</th></tr>
        ${(d.valueStock || []).map((v) => `<tr><td>${esc(v.name || fmtBRL(v.value))}</td><td>${v.count}</td></tr>`).join('') || '<tr><td colspan="2" class="empty">Sem estoque</td></tr>'}
      </table>
    </div>
    <div class="panel">
      <h3>Automação</h3>
      <pre class="mono">${esc(JSON.stringify(d.automation, null, 2))}</pre>
    </div>`;
}

async function viewNumbers() {
  const data = await api('/numbers?limit=50&offset=0');
  return `
    <div class="panel">
      <h3>Números no banco (${data.total})</h3>
      <table>
        <thead><tr><th>MSISDN</th><th>Status</th><th>Valores</th><th>Scan</th><th></th></tr></thead>
        <tbody id="numbers-tbody">${data.items.map(numberRow).join('')}</tbody>
      </table>
      ${data.items.length < data.total ? `<button id="numbers-more" class="btn secondary" data-offset="50">Carregar mais</button>` : ''}
    </div>`;
}

async function viewCards() {
  const data = await api(`/cards?reveal=${revealCards ? '1' : '0'}`);
  const list = (lines) => lines.length
    ? `<ol class="mono">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>`
    : '<p class="empty">Vazio</p>';
  return `
    <div class="toolbar">
      <button id="cards-reveal" class="btn secondary">${revealCards ? 'Ocultar PAN' : 'Mostrar PAN'}</button>
      <button id="cards-clear" class="btn danger">Limpar fila</button>
    </div>
    <div class="grid">
      <div class="card"><div class="label">Pendentes</div><div class="value">${data.counts.pending}</div></div>
      <div class="card"><div class="label">Aprovados</div><div class="value">${data.counts.approved}</div></div>
      <div class="card"><div class="label">Em uso</div><div class="value">${data.counts.inUse}</div></div>
    </div>
    <div class="panel">
      <h3>Adicionar cartões</h3>
      <form id="cards-ingest-form">
        <textarea id="cards-text" placeholder="PAN|MES|ANO|CVV (um por linha)"></textarea>
        <br><button type="submit" class="btn" style="margin-top:0.5rem">Importar</button>
      </form>
    </div>
    <div class="panel"><h3>Fila pendente</h3>${list(data.pending)}</div>
    <div class="panel"><h3>Aprovados</h3>${list(data.approved)}</div>
    <div class="panel"><h3>Reservados</h3>
      ${data.reserved.length ? `<table><tr><th>PAN</th><th>Chat</th><th>Desde</th></tr>
        ${data.reserved.map((r) => `<tr><td class="mono">${esc(r.line)}</td><td>${esc(r.chatId)}</td><td>${fmtDate(r.reservedAt)}</td></tr>`).join('')}
      </table>` : '<p class="empty">Nenhum</p>'}
    </div>`;
}

async function viewRecharges() {
  const data = await api('/recharges?limit=80');
  return `
    <div class="panel">
      <h3>Histórico de recargas (${data.total})</h3>
      <table>
        <thead><tr><th>Data</th><th>Usuário</th><th>Login</th><th>Destino</th><th>Produto</th><th>Cartão</th><th>Status</th><th>Gate</th><th>ms</th></tr></thead>
        <tbody>
          ${data.items.map((r) => `<tr>
            <td>${fmtDate(r.created_at)}</td>
            <td>${esc(r.username || r.chat_id)}</td>
            <td class="mono">${esc(r.login_msisdn)}</td>
            <td class="mono">${esc(r.target_msisdn)}</td>
            <td>${esc(r.product_name)} ${fmtBRL(r.product_value_cents)}</td>
            <td>****${esc(r.card_last4)}</td>
            <td><span class="badge ${r.status === 'success' ? 'ok' : r.status === 'error' ? 'err' : 'warn'}">${esc(r.status)}</span></td>
            <td class="mono">${esc(r.gate_code || r.gate_message || '—')}</td>
            <td>${r.duration_ms ?? '—'}</td>
          </tr>`).join('') || '<tr><td colspan="9" class="empty">Sem recargas</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

async function viewUsers() {
  const data = await api('/users?limit=100');
  return `
    <div class="panel">
      <h3>Usuários Telegram (${data.total})</h3>
      <table>
        <thead><tr><th>Chat ID</th><th>Username</th><th>Nome</th><th>Mensagens</th><th>Último acesso</th><th>Permitido</th><th></th></tr></thead>
        <tbody>
          ${data.items.map((u) => `<tr>
            <td class="mono">${esc(u.chat_id)}</td>
            <td>@${esc(u.username || '—')}</td>
            <td>${esc([u.first_name, u.last_name].filter(Boolean).join(' '))}</td>
            <td>${u.message_count}</td>
            <td>${fmtDate(u.last_seen)}</td>
            <td><span class="badge ${u.allowed ? 'ok' : 'err'}">${u.allowed ? 'sim' : 'bloqueado'}</span></td>
            <td>
              ${u.allowed
                ? `<button class="btn small danger" data-toggle-user="0" data-chat-id="${esc(u.chat_id)}">Bloquear</button>`
                : `<button class="btn small" data-toggle-user="1" data-chat-id="${esc(u.chat_id)}">Liberar</button>`}
            </td>
          </tr>`).join('') || '<tr><td colspan="7" class="empty">Nenhum usuário ainda</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

async function viewSessions() {
  let data;
  try { data = await api('/automation/sessions'); } catch { data = { sessions: [], error: true }; }
  return `
    <div class="panel">
      <h3>Sessões Edge (${data.aliveSessions ?? 0}/${data.maxConcurrentSessions ?? '?'} ativas)</h3>
      <table>
        <thead><tr><th>ID</th><th>Número</th><th>Destino</th><th>Status</th><th>Step</th><th>Browser</th><th></th></tr></thead>
        <tbody>
          ${(data.sessions || []).map((s) => `<tr>
            <td class="mono">${esc((s.sessionId || '').slice(0, 8))}…</td>
            <td class="mono">${esc(s.accessNumber)}</td>
            <td class="mono">${esc(s.rechargeTargetNumber || '—')}</td>
            <td><span class="badge neutral">${esc(s.status)}</span></td>
            <td>${esc(s.stepLabel || s.step)}</td>
            <td><span class="badge ${s.browserAlive ? 'ok' : 'err'}">${s.browserAlive ? 'vivo' : 'morto'}</span></td>
            <td><button class="btn small danger" data-close-session="${esc(s.sessionId)}">Fechar</button></td>
          </tr>`).join('') || '<tr><td colspan="7" class="empty">Nenhuma sessão ativa</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

async function viewLogs() {
  const bot = await api('/logs/bot?lines=300');
  return `
    <div class="tabs">
      <button class="tab log-tab active" data-log="bot">Bot</button>
      <button class="tab log-tab" data-log="automation">Automação</button>
      <button class="tab log-tab" data-log="admin">Admin</button>
    </div>
    <div class="log-view" id="log-output">${esc(bot.lines.join('\n') || '(vazio)')}</div>
    <p class="sub" style="margin-top:0.5rem;color:var(--muted)">${bot.totalLines ?? bot.lines.length} linhas · ${Math.round((bot.size || 0) / 1024)} KB</p>`;
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
      ${keys.map((k) => `
        <div class="form-row">
          <label>${esc(k)}</label>
          <input data-env-key="${esc(k)}" value="${esc(data.env[k] ?? '')}">
        </div>`).join('')}
      <button id="config-save" class="btn">Salvar alterações</button>
      <p style="color:var(--muted);margin-top:0.75rem;font-size:0.8rem">Token e senha admin não são editáveis aqui. Reinicie os serviços após mudanças.</p>
    </div>`;
}

async function viewSystem() {
  const data = await api('/system');
  return `
    <div class="toolbar">
      <button class="btn" data-system-action="run">Iniciar (run.sh)</button>
      <button class="btn secondary" data-system-action="stop">Parar (stop.sh)</button>
      <button class="btn danger" data-system-action="clear">Limpar logs (clear.sh)</button>
    </div>
    <div class="panel">
      <h3>Diretório de dados</h3>
      <p class="mono">${esc(data.dataDir)}</p>
    </div>
    <div class="panel">
      <h3>Arquivos</h3>
      <table>
        <tr><th>Arquivo</th><th>Tamanho</th><th>Modificado</th></tr>
        ${data.files.map((f) => `<tr><td>${esc(f.name)}</td><td>${Math.round(f.size / 1024)} KB</td><td>${fmtDate(f.mtime)}</td></tr>`).join('')}
      </table>
    </div>`;
}

if (token) {
  api('/me').then(() => { showApp(); renderView(); }).catch(() => showLogin());
} else {
  showLogin();
}

setInterval(() => {
  if (token && !$('#app').classList.contains('hidden')) renderView();
}, 30000);
