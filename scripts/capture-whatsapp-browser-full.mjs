import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'output');

const phone = process.argv[2];
const otp = process.argv[3];
const loginValue = /^\d+$/.test(process.argv[4] || '') ? Number(process.argv[4]) : 2000;
const skipSms = process.argv.includes('--skip-sms');
const smsOnly = process.argv.includes('--sms-only');

if (!phone) {
  console.error('Uso: node scripts/capture-whatsapp-browser-full.mjs <telefone> [otp] [valor_centavos] [--skip-sms] [--sms-only]');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const requests = [];
const responses = [];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'pt-BR', viewport: { width: 390, height: 844 } });
const page = await context.newPage();

if (skipSms) {
  await page.route('**/sms-tokens/**', (route) => {
    console.log('[browser] bloqueando reenvio SMS');
    route.fulfill({ status: 204, body: '', headers: { 'access-control-allow-origin': '*' } });
  });
}

page.on('request', (req) => {
  const url = req.url();
  if (/claro-recarga-api\.m4u\.com\.br/i.test(url)) {
    requests.push({
      ts: Date.now(),
      method: req.method(),
      url,
      postData: req.postData() || null,
    });
  }
});

page.on('response', async (res) => {
  const url = res.url();
  if (/claro-recarga-api\.m4u\.com\.br/i.test(url)) {
    let body = null;
    try { body = (await res.text()).slice(0, 20000); } catch {}
    const entry = {
      ts: Date.now(),
      method: res.request().method(),
      url,
      status: res.status(),
      body,
    };
    responses.push(entry);
    const short = url.replace('https://claro-recarga-api.m4u.com.br', '');
    console.log('[api]', res.status(), res.request().method(), short.slice(0, 90));
  }
});

await page.goto('https://clarorecarga.claro.com.br/whatsapp/landing', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(2000);

await page.getByRole('button', { name: 'Recarregar' }).first().click();
await page.waitForTimeout(1500);

const phoneInput = page.locator('input[type="tel"]').first();
await phoneInput.waitFor({ state: 'visible', timeout: 15000 });
await phoneInput.fill(phone);

await page.getByRole('button', { name: /Continuar/i }).click();
await page.waitForTimeout(3000);

const otpInput = page.locator('input[placeholder*="código" i]').first();
await otpInput.waitFor({ state: 'visible', timeout: 20000 });

if (smsOnly || !otp) {
  writeFileSync(join(OUT_DIR, 'whatsapp-browser-pending-otp.json'), JSON.stringify({
    phone,
    loginValue,
    skipSms,
    smsOnly,
    url: page.url(),
    message: 'SMS enviado (ou bloqueado reenvio). Informe OTP para continuar.',
    requests,
    responses,
  }, null, 2));
  console.log('\n=== AGUARDANDO OTP ===');
  console.log(`Telefone: ${phone}`);
  console.log('Execute: node scripts/capture-whatsapp-browser-full.mjs', phone, '<OTP>', loginValue, '--skip-sms');
  await browser.close();
  process.exit(0);
}

await otpInput.fill(otp);
await page.getByRole('button', { name: /Continuar|Confirmar|Avançar/i }).click();
await page.waitForTimeout(10000);

const sessionOk = responses.some((r) => r.url.includes('/sessions/') && r.method === 'POST' && r.status === 200);

for (const route of ['/whatsapp/pagamento', '/whatsapp/pix', '/whatsapp/valores', '/whatsapp/minhas-recargas']) {
  try {
    await page.goto(`https://clarorecarga.claro.com.br${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
  } catch (e) {
    console.log('[nav]', route, e.message);
  }
}

const report = {
  phone,
  otp,
  loginValue,
  skipSms,
  capturedAt: new Date().toISOString(),
  sessionOk,
  finalUrl: page.url(),
  pageText: (await page.locator('body').innerText()).slice(0, 5000),
  requests,
  responses,
};

writeFileSync(join(OUT_DIR, 'whatsapp-browser-full.json'), JSON.stringify(report, null, 2));

console.log('\n=== RESUMO ===');
console.log('Sessão OK:', sessionOk);
console.log('Requests API:', requests.length);
console.log('Responses API:', responses.length);
for (const r of responses.filter((x) => x.status === 200 && /products|payment|recharge|smartcheckout|sessions/i.test(x.url))) {
  console.log('---', r.status, r.url.replace('https://claro-recarga-api.m4u.com.br', ''));
  console.log((r.body || '').slice(0, 800));
}

await browser.close();
process.exit(sessionOk ? 0 : 1);
