import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'output');

const phone = process.argv[2];
const otp = process.argv[3];
const payCvv = (process.argv[7] && process.argv[7] !== '_') ? process.argv[7] : '0000';
const valueCents = /^\d+$/.test(process.argv[8] || '') ? Number(process.argv[8]) : 3500;
const skipSms = process.argv.includes('--skip-sms');
const linkedOnly = process.argv.includes('--linked-only');
const panRaw = linkedOnly ? '' : (process.argv[4] && process.argv[4] !== '_' ? process.argv[4] : '');
const month = process.argv[5] && process.argv[5] !== '_' ? process.argv[5] : '';
const year = process.argv[6] && process.argv[6] !== '_' ? process.argv[6] : '';
const pan = panRaw;
const last4 = pan ? pan.slice(-4) : '';
const year2 = year.length === 4 ? year.slice(-2) : year;

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
    if (await btn.isDisabled().catch(() => true)) return false;
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

const otpInput = page.locator('input[placeholder*="código" i]').first();
await otpInput.waitFor({ state: 'visible', timeout: 20000 });
await otpInput.fill(otp);
await clickIfVisible('Continuar|Confirmar|Avançar');
await page.waitForTimeout(8000);

const sessionOk = responses.some((r) => r.url.includes('/sessions/') && r.method === 'POST' && r.status === 200);
if (!sessionOk) {
  writeFileSync(join(OUT, 'link-card-browser-result.json'), JSON.stringify({
    phone, otp, payCvv, valueCents, error: 'session_failed', responses: responses.slice(-5),
  }, null, 2));
  console.error('Login OTP falhou — sessão não criada');
  await browser.close();
  process.exit(1);
}

await snap('pós-login');

// Aceitar cookies se bloquear cliques
await clickIfVisible('Aceitar cookies', 2000);

// 3) Modal pagamento R$35 — escolher Cartão de Crédito (ficar na página atual)
const creditOpt = page.getByText('Cartão de Crédito', { exact: true });
if (await creditOpt.isVisible({ timeout: 8000 }).catch(() => false)) {
  await creditOpt.click();
  await page.waitForTimeout(3000);
  console.log('[ui] Cartão de Crédito selecionado');
}

// Cadastrar novo cartão se PAN informado e ainda não vinculado
async function linkNewCardIfNeeded() {
  if (!pan || linkedOnly) return;
  const saved = last4 && await page.locator(`text=/${last4}/`).first().isVisible({ timeout: 2000 }).catch(() => false);
  if (saved) {
    console.log('[ui] cartão', last4, 'já visível');
    return;
  }

  await clickIfVisible('Adicionar|Novo cartão|Cadastrar cartão|Outro cartão', 2000);
  for (const route of ['/whatsapp/criar-cartao', '/whatsapp/novo-credito', '/whatsapp/pagamento-credito']) {
    if (/criar-cartao|novo-credito|pagamento-credito|pagamento-cartao/.test(page.url())) break;
    await page.goto(`https://clarorecarga.claro.com.br${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  await snap('form-cartão');

  const textInputs = page.locator('input:visible:not([type="checkbox"]):not([type="hidden"])');
  const count = await textInputs.count();
  const filled = [];
  for (let i = 0; i < count; i++) {
    const el = textInputs.nth(i);
    const ph = ((await el.getAttribute('placeholder')) || '').toLowerCase();
    const max = Number(await el.getAttribute('maxlength') || 99);
    const type = await el.getAttribute('type') || 'text';
    let value = null;
    if (/cart|número|numero|pan/.test(ph) || max >= 16) value = pan;
    else if (/valid|mm|expir|venc/.test(ph)) value = `${month}/${year2}`;
    else if (/m[eê]s|^mm$/.test(ph) || (max === 2 && !filled.includes('month'))) { value = month; filled.push('month'); }
    else if (/ano|aa|yy|aaaa/.test(ph) || (max === 4 && !filled.includes('year'))) { value = year; filled.push('year'); }
    else if (/cvv|cvc|segur/.test(ph) || max === 3 || max === 4) value = '999';
    else if (i === 0 && count >= 3) value = pan;
    else if (i === 1 && count >= 3) value = `${month}/${year2}`;

    if (value) {
      await el.click();
      await el.fill('');
      if (value === pan) await el.pressSequentially(pan, { delay: 30 });
      else await el.fill(value);
      await el.blur();
      console.log('[ui] input', i, ph || type, '←', value === pan ? `${pan.slice(0, 6)}...${last4}` : value);
    }
  }

  await page.waitForTimeout(1500);
  const saveBtn = page.getByRole('button', { name: /Salvar cartão/i });
  if (await saveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await saveBtn.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /salvar cart/i.test(x.textContent || ''));
      return b && !b.disabled;
    }, { timeout: 15000 }).catch(() => console.log('[ui] Salvar cartão ainda disabled'));
    if (!(await saveBtn.isDisabled())) {
      await saveBtn.click();
      console.log('[ui] Salvar cartão clicado');
      await page.waitForTimeout(8000);
    }
  } else {
    await clickIfVisible('Continuar|Confirmar|Cadastrar|Avançar', 5000);
    await page.waitForTimeout(5000);
  }

  const linked = responses.some((r) => r.url.includes('/payment-methods') && r.method === 'POST' && r.status < 300);
  const tokenized = responses.some((r) => /v1\/cc|eldorado/.test(r.url) && r.status === 200);
  console.log('[ui] vincular:', { linked, tokenized, last4 });
}

await linkNewCardIfNeeded();

// Selecionar cartão salvo pelos últimos 4 dígitos
if (last4) {
  const savedCard = page.locator(`text=/${last4}/`).first();
  if (await savedCard.isVisible({ timeout: 5000 }).catch(() => false)) {
    await savedCard.click();
    await page.waitForTimeout(2000);
    console.log('[ui] cartão', last4, 'selecionado');
  }
}

await clickIfVisible('Continuar|Confirmar|Avançar|Recarregar', 3000);

// Aguardar navegação natural para CVV (não forçar goto)
await page.waitForURL(/pagamento-cvv|pagamento-credito|confirmacao/, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(2000);

if (!page.url().includes('pagamento-cvv')) {
  await page.goto('https://clarorecarga.claro.com.br/whatsapp/pagamento-cvv', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2000);
}

// 4) CVV
const cvvCandidates = page.locator('input:visible').filter({ hasNot: page.locator('[type="checkbox"]') });
const cvvCount = await cvvCandidates.count();
for (let i = 0; i < cvvCount; i++) {
  const el = cvvCandidates.nth(i);
  const max = await el.getAttribute('maxlength');
  const type = await el.getAttribute('type');
  if (type === 'tel' || type === 'password' || type === 'number' || max === '3' || max === '4') {
    await el.click();
    await el.fill('');
    await el.fill(payCvv);
    console.log('[ui] CVV preenchido no input', i, 'maxlength', max);
    break;
  }
}

await snap('cvv preenchido');

const concluir = page.getByRole('button', { name: /CONCLUIR RECARGA/i });
if (await concluir.isVisible({ timeout: 5000 }).catch(() => false)) {
  await concluir.click();
  console.log('[ui] CONCLUIR RECARGA clicado');
  await page.waitForTimeout(20000);
} else {
  await page.locator('button:has-text("CONCLUIR")').first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(20000);
}

await snap('pós-concluir');
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
