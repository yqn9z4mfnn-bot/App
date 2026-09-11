#!/usr/bin/env node
/**
 * Mede tráfego via proxy até o formulário + fingerprint (sem preencher cartão).
 */
import '../lib/load-env.mjs';
import { listNumbers } from '../lib/numbers-db.mjs';
import { prepareCheckoutViaHttp } from '../lib/prepare-checkout-http.mjs';
import { launchBrowser, createMobileContext } from '../automation/browser.mjs';
import { ensureCheckoutLinkPanReady } from '../automation/checkout.mjs';

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '(outro)';
  }
}

function mb(n) {
  return (n / (1024 * 1024)).toFixed(2);
}

function headerBytes(headers) {
  if (!headers) return 0;
  return Object.entries(headers).reduce((s, [k, v]) => s + String(k).length + String(v).length + 4, 0);
}

const rows = (listNumbers({ limit: 120, onlyOk: true }) || []).filter((r) => r.link);
if (!rows.length) {
  console.error('sem número com link');
  process.exit(2);
}

let prep = null;
let httpMs = 0;
let lastErr = null;
for (const row of rows.slice(0, 12)) {
  const cents =
    [2000, 1500, 2500, 3000, 3500].find((c) =>
      (row.valores || []).some((v) => Number(v.value) === c),
    ) || 2000;
  const httpStarted = Date.now();
  try {
    prep = await prepareCheckoutViaHttp({
      loginUrl: row.link,
      msisdn: row.msisdn,
      valueCents: cents,
    });
    httpMs = Date.now() - httpStarted;
    break;
  } catch (err) {
    lastErr = err;
    httpMs = Date.now() - httpStarted;
  }
}
if (!prep) {
  console.error(String(lastErr?.message || lastErr || 'falha HTTP checkout'));
  process.exit(2);
}

const byHost = new Map();
const idHost = new Map();
const touch = (host) => {
  let row = byHost.get(host);
  if (!row) {
    row = { host, reqs: 0, up: 0, down: 0 };
    byHost.set(host, row);
  }
  return row;
};

const browser = await launchBrowser('edge');
const context = await createMobileContext(browser);
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');

cdp.on('Network.requestWillBeSent', (e) => {
  const url = e.request?.url || '';
  const host = hostOf(url);
  idHost.set(e.requestId, host);
  const up =
    Buffer.byteLength(url) +
    headerBytes(e.request?.headers) +
    Buffer.byteLength(e.request?.postData || '') +
    32;
  const row = touch(host);
  row.reqs += 1;
  row.up += up;
});

cdp.on('Network.loadingFinished', (e) => {
  const host = idHost.get(e.requestId) || '(outro)';
  const row = touch(host);
  row.down += (e.encodedDataLength || 0) + 360;
});

const t0 = Date.now();
await page.goto(prep.checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
const navMs = Date.now() - t0;
const ready = await ensureCheckoutLinkPanReady(page);
const afterPan = Date.now();
// fingerprint / SRC / Bemobi que numa recarga real sobem antes/durante o 3DS
await new Promise((r) => setTimeout(r, 18000));
const elapsedMs = Date.now() - t0;
await browser.close().catch(() => {});

const hosts = [...byHost.values()].sort((a, b) => b.down + b.up - (a.down + a.up));
const up = hosts.reduce((s, h) => s + h.up, 0);
const down = hosts.reduce((s, h) => s + h.down, 0);
const reqs = hosts.reduce((s, h) => s + h.reqs, 0);
const browserTotal = up + down;
// API HTTP (JWT, produtos, wallet, cards) é JSON pequeno — ~80–200 KB típico
const httpEstimate = 150 * 1024;
const postPayEstimate = 400 * 1024; // tokenizer + /payments + SSE + 3DS extra
const fullEstimate = browserTotal + httpEstimate + postPayEstimate;

const report = {
  ok: Boolean(ready),
  httpPrepMs: httpMs,
  navMs,
  panReadyMs: afterPan - t0,
  waitAfterPanMs: 18000,
  elapsedMs,
  browser: {
    requests: reqs,
    uploadMB: Number(mb(up)),
    downloadMB: Number(mb(down)),
    totalMB: Number(mb(browserTotal)),
  },
  httpApiEstimateMB: Number(mb(httpEstimate)),
  postPayEstimateMB: Number(mb(postPayEstimate)),
  perRechargeEstimateMB: Number(mb(fullEstimate)),
  topHosts: hosts.slice(0, 12).map((h) => ({
    host: h.host,
    reqs: h.reqs,
    mb: Number(mb(h.up + h.down)),
  })),
};

console.log(JSON.stringify(report, null, 2));
process.exit(ready ? 0 : 1);
