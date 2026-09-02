import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'output');

const phone = process.argv[2];
const otp = process.argv[3];
const pan = process.argv[4];
const month = process.argv[5];
const year = process.argv[6];
const payCvv = process.argv[7] || '0000';
const valueCents = /^\d+$/.test(process.argv[8] || '') ? Number(process.argv[8]) : 3500;
const skipSms = process.argv.includes('--skip-sms');

if (!phone || !otp) {
  console.error('Uso: node scripts/link-card-browser.mjs <telefone> <otp> [pan] [mes] [ano] [cvv_pagamento] [valor_centavos] [--skip-sms]');
  console.error('  Sem pan: usa cartão já vinculado. Com pan: cadastra antes de pagar.');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const requests = [];
const responses = [];

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ locale: 'pt-BR', viewport: { width: 390, height: 844 } })).newPage();

if (skipSms) {
  await page.route('**/sms-tokens/**', (route) => {
    console.log('[browser] bloqueio reenvio SMS');
    route.fulfill({ status: 204, body: '', headers: { 'access-control-allow-origin': '*' } });
  });
}

const logApi = (host) => {
  page.on('request', (req) => {
    const url = req.url();
    if (new RegExp(host, 'i').test(url)) {
      requests.push({ method: req.method(), url, postData: req.postData()?.slice(0, 5000) || null });
    }
  });
  page.on('response', async (res) => {
    const url = res.url();
    if (new RegExp(host, 'i').test(url)) {
      let body = null;
      try { body = (await res.text()).slice(0, 25000); } catch {}
      const entry = { method: res.request().method(), url, status: res.status(), body };
      responses.push(entry);
      const short = url.replace(/https:\/\/[^/]+/, '');
      console.log('[api]', res.status(), res.request().method(), short.slice(0, 100));
    }
  });
};

logApi('claro-recarga-api\\.m4u\\.com\\.br|eldorado\\.m4u\\.com\\.br');

async function snap(label) {
  console.log(`\n--- ${label} ---`, page.url());
  console.log((await page.locator('body').innerText()).slice(0, 800).replace(/\n+/g, '\n'));
}

async function clickIfVisible(text, timeout = 5000) {
  const btn = page.getByRole('button', { name: new RegExp(text, 'i') }).first();
  if (await btn.isVisible({ timeout }).catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(2000);
    return true;
  }
  return false;
}

// 1) Landing + valor R$ 35
await page.goto('https://clarorecarga.claro.com.br/whatsapp/landing', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(2000);

const valueBtn = page.getByRole('button', { name: 'Recarregar' });
const count = await valueBtn.count();
for (let i = 0; i < count; i++) {
  const card = valueBtn.nth(i);
  const text = await card.evaluate((el) => el.closest('div')?.innerText || el.innerText);
  if (text.includes('35') || valueCents === 3500 && i === 4) {
    await card.click();
    break;
  }
}
if (!page.url().includes('numero') && !await page.locator('input[type="tel"]').first().isVisible().catch(() => false)) {
  await valueBtn.first().click();
}
await page.waitForTimeout(1500);

// 2) Telefone + OTP
await page.locator('input[type="tel"]').first().fill(phone);
await clickIfVisible('Continuar');
await page.waitForTimeout(2500);

await page.locator('input[placeholder*="código" i]').first().fill(otp);
await clickIfVisible('Continuar|Confirmar|Avançar');
await page.waitForTimeout(10000);
await snap('pós-login');

// 3) Ir para pagamento / valores
for (const route of ['/whatsapp/selecionar-valor', '/whatsapp/valores', '/whatsapp/pagamento']) {
  try {
    await page.goto(`https://clarorecarga.claro.com.br${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
  } catch {}
}

// Selecionar R$ 35 se estiver em valores
await clickIfVisible('R\\$\\s*35|35,00', 3000);
await clickIfVisible('Recarregar|Continuar|Confirmar', 3000);

// 4) Escolher cartão de crédito
await clickIfVisible('Cartão|Crédito|credit', 8000);

// 5) Cadastrar cartão novo OU usar vinculado
if (pan) {
  await page.goto('https://clarorecarga.claro.com.br/whatsapp/novo-credito', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2000);

  const inputs = page.locator('input');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const ph = (await inputs.nth(i).getAttribute('placeholder')) || '';
    const name = (await inputs.nth(i).getAttribute('name')) || '';
    const type = (await inputs.nth(i).getAttribute('type')) || '';
    const label = `${ph} ${name}`.toLowerCase();
    if (/número|numero|cartão|cartao|card|pan/.test(label) || (type === 'tel' && i === 0)) {
      await inputs.nth(i).fill(pan);
    } else if (/mês|mes|month|validade/.test(label)) {
      await inputs.nth(i).fill(`${month}/${year.slice(-2)}`);
    } else if (/nome/.test(label)) {
      await inputs.nth(i).fill('TESTE CLARO');
    } else if (/cvv|código de segurança|codigo/.test(label)) {
      await inputs.nth(i).fill('000');
    }
  }

  // fallback: fill visible text inputs in order
  const vis = page.locator('input:visible');
  const vc = await vis.count();
  if (vc >= 3 && pan) {
    await vis.nth(0).fill(pan).catch(() => {});
    await vis.nth(1).fill(`${month}/${year.slice(-2)}`).catch(() => {});
    if (vc >= 4) await vis.nth(3).fill('000').catch(() => {});
  }

  await snap('novo-credito preenchido');
  await clickIfVisible('Continuar|Confirmar|Salvar|Cadastrar', 5000);
  await page.waitForTimeout(5000);
} else {
  // clicar cartão Elo final 6714 se visível
  await clickIfVisible('6714|ELO|Elo', 5000);
}

// 6) CVV na hora de pagar
await page.goto('https://clarorecarga.claro.com.br/whatsapp/pagamento-cvv', { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(2000);

const cvvInput = page.locator('input[type="password"], input[type="tel"], input[maxlength="3"], input[maxlength="4"], input[placeholder*="cvv" i], input[placeholder*="código" i]').first();
if (await cvvInput.isVisible({ timeout: 8000 }).catch(() => false)) {
  await cvvInput.fill(payCvv);
  await snap('cvv preenchido');
  await clickIfVisible('Continuar|Confirmar|Pagar|Recarregar', 5000);
  await page.waitForTimeout(15000);
} else {
  // tentar CVV em qualquer input visível curto
  const short = page.locator('input:visible[maxlength="4"], input:visible[maxlength="3"]');
  if (await short.count() > 0) {
    await short.first().fill(payCvv);
    await clickIfVisible('Continuar|Confirmar|Pagar', 5000);
    await page.waitForTimeout(15000);
  }
}

await snap('final');
for (const route of ['/whatsapp/confirmacao', '/whatsapp/pagamento-sucesso', '/whatsapp/pagamento-erro']) {
  try {
    await page.goto(`https://clarorecarga.claro.com.br${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    if (!(await page.locator('body').innerText()).includes('não encontrada')) break;
  } catch {}
}

writeFileSync(join(OUT, 'link-card-browser-result.json'), JSON.stringify({
  phone,
  pan: pan ? `${pan.slice(0, 6)}...${pan.slice(-4)}` : null,
  payCvv,
  valueCents,
  finalUrl: page.url(),
  pageText: (await page.locator('body').innerText()).slice(0, 6000),
  requests,
  responses: responses.map((r) => ({
    ...r,
    body: (r.body || '').slice(0, 8000),
  })),
}, null, 2));

console.log('\n=== GATE / RECHARGE ===');
for (const r of responses.filter((x) => /recharges|payment-methods|v1\/cc|eldorado/i.test(x.url))) {
  console.log(r.status, r.method, r.url.replace(/https:\/\/[^/]+/, ''));
  console.log((r.body || '').slice(0, 1200));
}

await browser.close();
