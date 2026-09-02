import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'output');

const phone = process.argv[2];
const otp = process.argv[3];
if (!phone || !otp) {
  console.error('Uso: node scripts/capture-whatsapp-otp.mjs <telefone> <codigo-otp>');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const requests = [];
const responses = [];

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({
  locale: 'pt-BR',
  viewport: { width: 390, height: 844 },
})).newPage();

page.on('request', (req) => {
  const url = req.url();
  if (/m4u|bemobi|eldorado|execute-api|sms-tokens|sessions|products|payment|recharge|customer/i.test(url)) {
    requests.push({ method: req.method(), url, postData: req.postData() || null });
  }
});
page.on('response', async (res) => {
  const url = res.url();
  if (/m4u|bemobi|eldorado|sms-tokens|sessions|products|payment|recharge|customer/i.test(url)) {
    let body = null;
    try { body = (await res.text()).slice(0, 8000); } catch {}
    responses.push({ method: res.request().method(), url, status: res.status(), body });
  }
});

await page.goto('https://clarorecarga.claro.com.br/whatsapp/landing', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(2000);

await page.getByRole('button', { name: 'Recarregar' }).first().click();
await page.waitForTimeout(2000);

const phoneInput = page.locator('input[type="tel"]').first();
await phoneInput.fill(phone);
await page.getByRole('button', { name: /Continuar/i }).click();
await page.waitForTimeout(3000);

const otpInput = page.locator('input[placeholder*="código" i], input[type="tel"]').first();
await otpInput.fill(otp);
await page.getByRole('button', { name: /Continuar|Confirmar|Avançar|Recarregar/i }).click();
await page.waitForTimeout(8000);

// Explore post-login pages
for (const route of ['/whatsapp/valores', '/whatsapp/pagamento', '/whatsapp/payment-methods']) {
  try {
    await page.goto(`https://clarorecarga.claro.com.br${route}`, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);
  } catch {}
}

const report = {
  phone,
  capturedAt: new Date().toISOString(),
  finalUrl: page.url(),
  pageText: (await page.locator('body').innerText()).slice(0, 3000),
  requests,
  responses,
};

writeFileSync(join(OUT_DIR, 'whatsapp-otp-authenticated.json'), JSON.stringify(report, null, 2));

console.log('\n=== REQUESTS ===');
for (const r of requests) console.log(r.method, r.url, r.postData?.slice(0, 400) || '');
console.log('\n=== RESPONSES ===');
for (const r of responses) console.log(r.status, r.url, (r.body || '').slice(0, 500));

await browser.close();
