import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'output');

const session = JSON.parse(process.argv[2] || '{}');
if (!session.id) {
  console.error('Uso: node scripts/capture-with-session.mjs \'{"id":"...","identifier":"...","partnerExternalId":"..."}\'');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const responses = [];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'pt-BR', viewport: { width: 390, height: 844 } });
const page = await context.newPage();

page.on('response', async (res) => {
  const url = res.url();
  if (/claro-recarga-api\.m4u\.com\.br/i.test(url)) {
    let body = null;
    try { body = (await res.text()).slice(0, 12000); } catch {}
    responses.push({ method: res.request().method(), url, status: res.status(), body });
    console.log(res.status(), res.request().method(), url.replace('https://claro-recarga-api.m4u.com.br', ''));
  }
});

await page.goto('https://clarorecarga.claro.com.br/whatsapp/landing', { waitUntil: 'domcontentloaded' });
await page.evaluate((s) => {
  localStorage.setItem('token', s.id);
  localStorage.setItem('identifier', s.identifier);
  localStorage.setItem('msisdn', s.identifier);
  sessionStorage.setItem('token', s.id);
  sessionStorage.setItem('channelPath', 'whatsapp');
}, session);

for (const route of ['/whatsapp/valores', '/whatsapp/pagamento', '/whatsapp/pix', '/whatsapp/landing']) {
  try {
    await page.goto(`https://clarorecarga.claro.com.br${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
  } catch (e) {
    console.log('route fail', route, e.message);
  }
}

writeFileSync(join(OUT_DIR, 'whatsapp-session-injected.json'), JSON.stringify({
  session,
  finalUrl: page.url(),
  pageText: (await page.locator('body').innerText()).slice(0, 4000),
  responses,
}, null, 2));

await browser.close();
