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
    if (/clarorecarga\.claro\.com\.br|claro-recarga\.m4u\.com\.br|\.m4u\.com\.br|\.claro\.com\.br|\.blip\.ai/.test(host)) {
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
  if (text.length > 2000) return text.slice(0, 2000) + '…';
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
    headers: req.headers(),
    postData: summarizeBody(req.postData()),
  });
});

page.on('response', async (res) => {
  const req = res.request();
  let body = null;
  const ct = res.headers()['content-type'] || '';
  if (/json|text\/plain|xml|javascript/.test(ct) && classify(res.url()) === 'app') {
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

console.log('Loading', TARGET_URL);
await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(5000);

// Try common interactions on WhatsApp flow
const selectors = [
  'input[type="tel"]',
  'input[name*="phone" i]',
  'input[placeholder*="celular" i]',
  'input[placeholder*="telefone" i]',
  'button',
  'a',
];

for (const sel of selectors) {
  const els = await page.locator(sel).all();
  for (const el of els.slice(0, 5)) {
    try {
      if (!(await el.isVisible())) continue;
      const tag = await el.evaluate((n) => n.tagName.toLowerCase());
      if (tag === 'input') {
        await el.fill('11999999999');
        await page.waitForTimeout(1500);
      }
    } catch {
      /* ignore */
    }
  }
}

// Click visible primary actions
for (const text of ['Continuar', 'Avançar', 'Recarregar', 'Próximo', 'Confirmar']) {
  try {
    const btn = page.getByRole('button', { name: new RegExp(text, 'i') }).first();
    if (await btn.isVisible({ timeout: 1000 })) {
      await btn.click({ timeout: 3000 });
      await page.waitForTimeout(3000);
    }
  } catch {
    /* ignore */
  }
}

const routes = {};
for (const r of requests.filter((x) => x.category === 'app')) {
  try {
    const u = new URL(r.url);
    const key = `${r.method} ${u.origin}${u.pathname}`;
    if (!routes[key]) {
      routes[key] = {
        method: r.method,
        origin: u.origin,
        pathname: u.pathname,
        queryKeys: [...new Set([...(routes[key]?.queryKeys || []), ...u.searchParams.keys()])],
        hits: 0,
        sampleQuery: u.search || '',
        samplePostData: null,
        resourceTypes: new Set(),
      };
    }
    routes[key].hits += 1;
    routes[key].resourceTypes.add(r.resourceType);
    if (r.postData) routes[key].samplePostData = r.postData;
    for (const q of u.searchParams.keys()) {
      if (!routes[key].queryKeys.includes(q)) routes[key].queryKeys.push(q);
    }
  } catch {
    /* ignore */
  }
}

const report = {
  targetUrl: TARGET_URL,
  capturedAt: new Date().toISOString(),
  pageTitle: await page.title(),
  finalUrl: page.url(),
  totalRequests: requests.length,
  appRequests: requests.filter((x) => x.category === 'app').length,
  analyticsRequests: requests.filter((x) => x.category === 'analytics').length,
  routes: Object.values(routes)
    .map((r) => ({
      ...r,
      resourceTypes: [...r.resourceTypes],
    }))
    .sort((a, b) => a.pathname.localeCompare(b.pathname)),
  requests: requests.filter((x) => x.category === 'app'),
  responses: responses.filter((x) => x.category === 'app'),
};

writeFileSync(join(OUT_DIR, 'whatsapp-network-capture.json'), JSON.stringify(report, null, 2));

console.log('\n=== APP ROUTES ===');
for (const r of report.routes) {
  console.log(`${r.method} ${r.pathname}${r.sampleQuery}${r.samplePostData ? ' [body]' : ''} (${r.hits}x)`);
}

await browser.close();
