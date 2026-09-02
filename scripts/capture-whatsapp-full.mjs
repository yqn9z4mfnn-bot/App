import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'output');
const TARGET_URL = 'https://clarorecarga.claro.com.br/whatsapp/';

mkdirSync(OUT_DIR, { recursive: true });

const requests = [];
const responses = [];

function classify(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (/clarorecarga\.claro\.com\.br|claro-recarga\.m4u\.com\.br|\.m4u\.com\.br|\.claro\.com\.br|\.blip\.ai|\.bemobi\.|execute-api\.us-east-1\.amazonaws\.com/.test(host)) {
      return 'app';
    }
    if (/google|hotjar|newrelic|nr-data|facebook|twitter|criteo|onetrust|cookielaw|doubleclick|googletagmanager/.test(host)) {
      return 'analytics';
    }
    return 'other';
  } catch {
    return 'other';
  }
}

function summarizeBody(body) {
  if (!body) return null;
  const text = typeof body === 'string' ? body : body.toString('utf8');
  if (text.length > 4000) return text.slice(0, 4000) + '…';
  return text;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'pt-BR',
  userAgent:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();

page.on('request', (req) => {
  requests.push({
    ts: Date.now(),
    method: req.method(),
    url: req.url(),
    resourceType: req.resourceType(),
    category: classify(req.url()),
    postData: summarizeBody(req.postData()),
  });
});

page.on('response', async (res) => {
  const req = res.request();
  let body = null;
  const ct = res.headers()['content-type'] || '';
  if (classify(res.url()) === 'app' && /json|text\/plain|xml|javascript|html/.test(ct)) {
    try {
      body = summarizeBody(await res.text());
    } catch {
      body = null;
    }
  }
  responses.push({
    ts: Date.now(),
    method: req.method(),
    url: res.url(),
    status: res.status(),
    category: classify(res.url()),
    contentType: ct,
    body,
  });
});

async function snap(name) {
  await page.screenshot({ path: join(OUT_DIR, `${name}.png`), fullPage: true });
  console.log('STEP', name, '->', page.url());
}

console.log('Loading', TARGET_URL);
await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(3000);
await snap('01-landing');

// Accept cookies if present
for (const label of ['Aceitar', 'Aceitar todos', 'Concordo', 'OK']) {
  try {
    const btn = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
    if (await btn.isVisible({ timeout: 1500 })) {
      await btn.click();
      await page.waitForTimeout(1500);
      break;
    }
  } catch {}
}

// Fill phone inputs
const phoneSelectors = [
  'input[type="tel"]',
  'input[inputmode="numeric"]',
  'input[name*="phone" i]',
  'input[name*="msisdn" i]',
  'input[placeholder*="celular" i]',
  'input[placeholder*="telefone" i]',
  'input[placeholder*="DDD" i]',
];
for (const sel of phoneSelectors) {
  const inputs = page.locator(sel);
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    try {
      if (await input.isVisible()) {
        await input.click({ timeout: 2000 });
        await input.fill('21987654321');
        await page.waitForTimeout(1000);
      }
    } catch {}
  }
}
await snap('02-phone-filled');

// Click recharge values
const valueSelectors = [
  '[data-testid*="value" i]',
  '[class*="value" i]',
  'button:has-text("R$")',
  'div:has-text("R$")',
];
for (const sel of valueSelectors) {
  const els = page.locator(sel);
  const count = Math.min(await els.count(), 8);
  for (let i = 0; i < count; i++) {
    try {
      const el = els.nth(i);
      if (await el.isVisible()) {
        await el.click({ timeout: 2000 });
        await page.waitForTimeout(2500);
      }
    } catch {}
  }
}
await snap('03-values-clicked');

// Generic continue buttons
for (const text of ['Continuar', 'Avançar', 'Recarregar', 'Próximo', 'Confirmar', 'Pagar', 'Finalizar', 'Escolher']) {
  try {
    const btn = page.getByRole('button', { name: new RegExp(text, 'i') }).first();
    if (await btn.isVisible({ timeout: 1000 })) {
      await btn.click({ timeout: 3000 });
      await page.waitForTimeout(3000);
      await snap(`04-after-${text.toLowerCase()}`);
    }
  } catch {}
}

// Try SPA routes directly
const spaRoutes = [
  '/whatsapp/landing',
  '/whatsapp/numero',
  '/whatsapp/valores',
  '/whatsapp/pagamento',
  '/whatsapp/confirmacao',
  '/whatsapp/recarga',
  '/whatsapp/login',
  '/whatsapp/payment',
  '/whatsapp/checkout',
];
for (const route of spaRoutes) {
  try {
    await page.goto(`https://clarorecarga.claro.com.br${route}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2500);
    await snap(`route-${route.replace(/\//g, '_')}`);
  } catch (e) {
    console.log('route fail', route, e.message);
  }
}

const apiRoutes = {};
for (const r of requests.filter((x) => x.category === 'app' && ['xhr', 'fetch', 'document'].includes(x.resourceType) || /m4u|execute-api|bemobi|\/v1\/|\/api\/|\/loop\/|\/sessions\/|\/products|\/payment|\/recharges|\/smartcheckout|\/customer|\/sms-tokens|\/scheduled-recharges|\/auth\//.test(x.url))) {
  try {
    const u = new URL(r.url);
    const key = `${r.method} ${u.origin}${u.pathname}`;
    if (!apiRoutes[key]) {
      apiRoutes[key] = {
        method: r.method,
        host: u.hostname,
        pathname: u.pathname,
        queryKeys: [],
        hits: 0,
        sampleQuery: '',
        samplePostData: null,
        statuses: new Set(),
      };
    }
    apiRoutes[key].hits += 1;
    if (r.postData) apiRoutes[key].samplePostData = r.postData;
    apiRoutes[key].sampleQuery = u.search || apiRoutes[key].sampleQuery;
    for (const q of u.searchParams.keys()) {
      if (!apiRoutes[key].queryKeys.includes(q)) apiRoutes[key].queryKeys.push(q);
    }
  } catch {}
}

for (const res of responses.filter((x) => x.category === 'app')) {
  try {
    const u = new URL(res.url);
    const key = `${res.method} ${u.origin}${u.pathname}`;
    if (apiRoutes[key]) apiRoutes[key].statuses.add(res.status);
  } catch {}
}

const frontendRoutes = new Set();
for (const r of requests.filter((x) => x.category === 'app' && x.resourceType === 'document')) {
  try {
    frontendRoutes.add(new URL(r.url).pathname);
  } catch {}
}

const report = {
  targetUrl: TARGET_URL,
  capturedAt: new Date().toISOString(),
  pageTitle: await page.title(),
  finalUrl: page.url(),
  frontendRoutes: [...frontendRoutes].sort(),
  totalRequests: requests.length,
  apiRoutes: Object.values(apiRoutes)
    .map((r) => ({ ...r, statuses: [...(r.statuses || [])] }))
    .sort((a, b) => `${a.host}${a.pathname}`.localeCompare(`${b.host}${b.pathname}`)),
  requests: requests.filter((x) => x.category === 'app'),
  responses: responses.filter((x) => x.category === 'app' && x.body),
};

writeFileSync(join(OUT_DIR, 'whatsapp-full-capture.json'), JSON.stringify(report, null, 2));

console.log('\n=== FRONTEND ROUTES ===');
for (const r of report.frontendRoutes) console.log(r);
console.log('\n=== API ROUTES ===');
for (const r of report.apiRoutes) {
  console.log(`${r.method} https://${r.host}${r.pathname}${r.sampleQuery}${r.samplePostData ? ' [body]' : ''} (${r.hits}x status=${(r.statuses||[]).join(',')})`);
}

await browser.close();
