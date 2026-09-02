import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'output');
const BASE = 'https://claro-recarga-api.m4u.com.br';

const phone = process.argv[2];
const otp = process.argv[3];
const loginValue = Number(process.argv[4] || 2000);
const skipSms = process.argv.includes('--skip-sms');

if (!phone || !otp) {
  console.error('Uso: node scripts/capture-whatsapp-otp-browser.mjs <telefone> <otp> [valor_centavos] [--skip-sms]');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const log = [];

async function apiCall(method, path, body, headers = {}) {
  const url = BASE + path;
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Channel: 'whatsapp', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const entry = { method, url, status: res.status, requestBody: body ?? null, responseBody: json ?? text.slice(0, 15000) };
  log.push(entry);
  console.log('[api]', method, path, res.status, JSON.stringify(json ?? text.slice(0, 200)).slice(0, 300));
  return { status: res.status, json, text };
}

// Try direct API login first (fastest path)
const sessionBody = {
  msisdn: phone,
  data: otp,
  type: 'sms',
  channel: ['whatsapp', 'CLARO_WHATSAPP'],
  origin: 'landing',
  loading: true,
  loginAction: 'loginWithRechargeValue',
  loginValue,
};

const session = await apiCall('POST', '/sessions/', sessionBody);
if (session.status === 429) {
  console.error('[api] Rate limit em POST /sessions/ — aguarde ~2 min antes de tentar outro OTP');
  writeFileSync(join(OUT_DIR, 'whatsapp-otp-complete.json'), JSON.stringify({ phone, otp, log, rateLimited: true }, null, 2));
  process.exit(1);
}

if (session.status === 200 && session.json?.id) {
  const token = session.json.id;
  const identifier = session.json.identifier || phone;
  const auth = { Authorization: `claro ${token}`, Channel: 'whatsapp' };

  const endpoints = [
    ['GET', `/sessions/${identifier}/tmp/token`],
    ['GET', `/customers/${identifier}/products`],
    ['GET', `/customers/${identifier}/payment-methods`],
    ['GET', `/customers/${identifier}/recharges`],
    ['POST', `/customers/${identifier}/smartcheckout/v2/url`, { channel: ['whatsapp', 'CLARO_WHATSAPP'], msisdn: identifier }],
  ];

  for (const [method, path, body] of endpoints) {
    await apiCall(method, path, body, auth);
  }

  writeFileSync(join(OUT_DIR, 'whatsapp-otp-complete.json'), JSON.stringify({
    phone, otp, session: session.json, authHeader: `claro ${token}`, identifier, log,
  }, null, 2));
  process.exit(0);
}

console.log('[api] OTP direto falhou — tentando fluxo browser com interceptação de SMS...');

const requests = [];
const responses = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'pt-BR', viewport: { width: 390, height: 844 } });
const page = await context.newPage();

if (skipSms) {
  await page.route('**/sms-tokens/**', (route) => {
    console.log('[browser] bloqueando reenvio SMS');
    route.fulfill({ status: 204, body: '' });
  });
}

page.on('request', (req) => {
  const url = req.url();
  if (/m4u|sms-tokens|sessions|products|payment|recharge|customer|smartcheckout/i.test(url)) {
    requests.push({ method: req.method(), url, postData: req.postData() || null });
  }
});
page.on('response', async (res) => {
  const url = res.url();
  if (/m4u|sms-tokens|sessions|products|payment|recharge|customer|smartcheckout/i.test(url)) {
    let body = null;
    try { body = (await res.text()).slice(0, 12000); } catch {}
    responses.push({ method: res.request().method(), url, status: res.status(), body });
    console.log('[browser]', res.status(), res.request().method(), url.split('.br').pop()?.slice(0, 80));
  }
});

await page.goto('https://clarorecarga.claro.com.br/whatsapp/landing', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(1500);
await page.getByRole('button', { name: 'Recarregar' }).first().click();
await page.waitForTimeout(1500);

const phoneInput = page.locator('input[type="tel"]').first();
await phoneInput.fill(phone);
await page.getByRole('button', { name: /Continuar/i }).click();
await page.waitForTimeout(2500);

const otpInput = page.locator('input[placeholder*="código" i]').first();
await otpInput.waitFor({ state: 'visible', timeout: 15000 });
await otpInput.fill(otp);
await page.getByRole('button', { name: /Continuar|Confirmar|Avançar/i }).click();
await page.waitForTimeout(8000);

for (const route of ['/whatsapp/pagamento', '/whatsapp/pix', '/whatsapp/checkout']) {
  try {
    await page.goto(`https://clarorecarga.claro.com.br${route}`, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2500);
  } catch {}
}

writeFileSync(join(OUT_DIR, 'whatsapp-otp-browser.json'), JSON.stringify({
  phone, otp, skipSms, finalUrl: page.url(),
  pageText: (await page.locator('body').innerText()).slice(0, 4000),
  apiLog: log, requests, responses,
}, null, 2));

await browser.close();
process.exit(responses.some((r) => r.url.includes('/sessions/') && r.status === 200) ? 0 : 1);
