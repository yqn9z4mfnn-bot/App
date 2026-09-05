#!/usr/bin/env node
/**
 * Confere se o Edge sai pelo Smartproxy (não pelo IP da VPS).
 * Uso na VPS: cd app && set -a && . ../.env && set +a && node scripts/check-browser-proxy.mjs
 */
import '../lib/load-env.mjs';
import { fetchProxyEgressIp, describeProxy, proxyEnabled } from '../lib/proxy.mjs';
import { launchBrowser, createMobileContext } from '../automation/browser.mjs';

const VPS_HINT = '147.93.13.252';

function extractIp(text) {
  const raw = String(text ?? '').trim();
  const m = raw.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return m ? m[1] : raw.slice(0, 200);
}

async function readPageIp(page, url) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  const body = await page.locator('body').innerText().catch(() => '');
  return {
    status: res?.status() ?? 0,
    ip: extractIp(body || (await res?.text().catch(() => ''))),
    url: page.url(),
  };
}

const direct = await fetch('https://api.ipify.org').then((r) => r.text()).catch((e) => `err:${e.message}`);
const httpProxy = await fetchProxyEgressIp({ rotateIp: false }).catch((e) => `err:${e.message}`);

console.log(
  JSON.stringify(
    {
      proxyEnabled: proxyEnabled(),
      describe: describeProxy(),
      vpsDirect: direct,
      httpViaProxy: httpProxy,
    },
    null,
    2,
  ),
);

if (!proxyEnabled()) {
  console.error('PROXY_ENABLED=0 — abort');
  process.exit(2);
}

const browser = await launchBrowser('edge');
const context = await createMobileContext(browser);
const page = await context.newPage();

try {
  const ipify = await readPageIp(page, 'https://api.ipify.org');
  let eldorado = { status: 0, ip: null, url: null, error: null };
  try {
    eldorado = await readPageIp(page, 'https://eldorado.m4u.com.br/v1/ip');
  } catch (err) {
    eldorado.error = err.message;
  }

  const leaked =
    ipify.ip === String(direct).trim() ||
    ipify.ip === VPS_HINT ||
    String(eldorado.ip) === VPS_HINT;

  const report = {
    edgeIpify: ipify,
    edgeEldoradoIp: eldorado,
    matchesHttpProxy: ipify.ip === httpProxy,
    leakedVpsIp: leaked,
    ok: !leaked && Boolean(ipify.ip) && ipify.ip !== String(direct).trim(),
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
} finally {
  await browser.close().catch(() => {});
}
