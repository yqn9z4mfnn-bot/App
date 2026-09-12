#!/usr/bin/env node
/**
 * Recarga cruzada alternando proxy ON/OFF a cada tentativa.
 * Uso: node scripts/run-cross-recharge-proxy-batch.mjs <destino> <valor> [max]
 */
import { spawnSync } from 'node:child_process';
import '../lib/load-env.mjs';
import { generateLoginMsisdn } from '../lib/generate-msisdn.mjs';
import { cardToPam } from '../lib/card-to-pam.mjs';
import { parseCardInput } from '../lib/card-parse.mjs';
import { mapAutomationPaymentStatus, waitForAutomationIdle } from '../lib/automation-client.mjs';
import { createCardListStore } from '../lib/card-list.mjs';
import { getDataDir } from '../lib/data-dir.mjs';
import { classifyCardListAction } from '../lib/card-outcome.mjs';

const target = String(process.argv[2] ?? '').replace(/\D/g, '');
const valueReais = String(process.argv[3] ?? '35').replace(/\D/g, '');
const maxAttempts = Math.min(10, Math.max(1, Number(process.argv[4] ?? 5) || 5));
const API = process.env.AUTOMATION_API_URL || 'http://127.0.0.1:3000';
const cardList = createCardListStore(getDataDir());
const SCRIPT_CHAT = 'cross-proxy-batch';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DATA_DIR = getDataDir();
const APP_DIR = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const TMUX = 'tmux -f /exec-daemon/tmux.portal.conf';

if (!target || target.length !== 11) {
  console.error('Uso: node scripts/run-cross-recharge-proxy-batch.mjs <destino> <valor> [max]');
  process.exit(1);
}

async function restartAutomation(proxyOn) {
  const envExport = [
    'export XDG_DATA_HOME=/home/ubuntu/.local/share/cloud-bot-home',
    `set -a; source ${DATA_DIR}/.env; set +a`,
    `export NUMBERS_DB=${DATA_DIR}/numbers.db`,
    `export ADMIN_DB=${DATA_DIR}/admin.db`,
    `export PROXY_ENABLED=${proxyOn ? '1' : '0'}`,
    `cd ${APP_DIR}`,
    'node automation/run.mjs',
  ].join('; ');

  spawnSync(TMUX, ['kill-session', '-t', 'cloud-automation'], { stdio: 'ignore' });
  spawnSync(
    TMUX,
    ['new-session', '-d', '-s', 'cloud-automation', '-c', APP_DIR, '--', 'bash', '-lc', envExport],
    { stdio: 'ignore' },
  );

  return waitHealth();
}

async function waitHealth() {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${API.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // wait
    }
    await sleep(1000);
  }
  return false;
}

async function pickCardLine() {
  const reserved = await cardList.reserveNextCard(SCRIPT_CHAT);
  if (!reserved?.line) throw new Error('Sem cartão na fila pending');
  return reserved.line;
}

async function applyCardOutcome(line, outcome, error) {
  const action = classifyCardListAction({ outcome, error });
  if (action === 'return') await cardList.applyOutcome(line, 'return', '', SCRIPT_CHAT);
  else if (action === 'approved') await cardList.applyOutcome(line, 'approved', '', SCRIPT_CHAT);
  else await cardList.applyOutcome(line, 'consumed', outcome?.result?.gateCode || outcome?.result?.message || '', SCRIPT_CHAT);
  return action;
}

console.log(`=== proxy-batch destino=${target} R$${valueReais} max=${maxAttempts} ===\n`);

for (let i = 1; i <= maxAttempts; i++) {
  const proxyOn = i % 2 === 0;
  console.log(`\n--- tentativa ${i}/${maxAttempts} proxy=${proxyOn ? 'ON' : 'OFF'} ---`);

  if (!(await restartAutomation(proxyOn))) {
    console.log('automação não subiu — pulando');
    continue;
  }

  await waitForAutomationIdle({ timeoutMs: 180000, pollMs: 500 });

  const cardLine = await pickCardLine();
  const card = parseCardInput(cardLine);
  const pamInfo = cardToPam(card);
  const pan = pamInfo.split('|')[0];

  let login;
  try {
    login = await generateLoginMsisdn({ maxAttempts: 8 });
  } catch (err) {
    console.log(`falha login: ${err.message}`);
    await cardList.applyOutcome(cardLine, 'return', '', SCRIPT_CHAT);
    continue;
  }

  console.log(`login=${login.msisdn} → ${target} ****${pan.slice(-4)} proxy=${proxyOn ? 'ON' : 'OFF'}`);

  const started = Date.now();
  let data;
  try {
    const res = await fetch(`${API.replace(/\/$/, '')}/api/session/start-checkout-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        loginUrl: login.link,
        accessNumber: login.msisdn,
        rechargeTargetNumber: target,
        rechargeValue: valueReais,
        pamInfo,
        browser: 'edge',
      }),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.log(`HTTP ${res.status}: ${data.error || JSON.stringify(data).slice(0, 120)}`);
      await cardList.applyOutcome(cardLine, 'return', '', SCRIPT_CHAT);
      continue;
    }
  } catch (err) {
    console.log(`rede: ${err.message}`);
    await cardList.applyOutcome(cardLine, 'return', '', SCRIPT_CHAT);
    continue;
  }

  const pr = data.paymentResult ?? {};
  const mapped = mapAutomationPaymentStatus(pr, data);
  const msg = String(pr.gateMessage || pr.message || data.lastError || '');

  console.log(
    JSON.stringify({
      attempt: i,
      proxy: proxyOn ? 'ON' : 'OFF',
      login: login.msisdn,
      cardMask: `****${pan.slice(-4)}`,
      mapped,
      gateCode: pr.gateCode ?? null,
      gateMessage: msg.slice(0, 160),
      visualVbv: pr.visualVbv ?? false,
      totalMs: data.timings?.totalMs ?? Date.now() - started,
      cardAction: await applyCardOutcome(
        cardLine,
        { result: { status: mapped, gateCode: pr.gateCode, message: msg, negativeReason: msg }, automation: { raw: pr } },
        null,
      ),
    }),
  );

  if (mapped === 'CONFIRMED') {
    console.log(`\n✅ APROVADO tentativa ${i} proxy=${proxyOn ? 'ON' : 'OFF'}`);
    await restartAutomation(false);
    process.exit(0);
  }

  await sleep(800);
}

console.log(`\n❌ ${maxAttempts} tentativas sem aprovação`);
await restartAutomation(false);
process.exit(1);
