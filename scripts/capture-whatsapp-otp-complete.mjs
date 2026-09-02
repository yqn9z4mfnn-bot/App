import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'output');
const BASE = 'https://claro-recarga-api.m4u.com.br';

const phone = process.argv[2];
const otp = process.argv[3];
const loginValue = Number(process.argv[4] || 2000);

if (!phone || !otp) {
  console.error('Uso: node scripts/capture-whatsapp-otp-complete.mjs <telefone> <otp> [valor_centavos]');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const log = [];

async function call(method, path, body, headers = {}) {
  const url = path.startsWith('http') ? path : BASE + path;
  const init = {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Channel: 'whatsapp', ...headers },
  };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const entry = { method, url, status: res.status, requestBody: body ?? null, responseBody: json ?? text.slice(0, 15000) };
  log.push(entry);
  console.log(method, path, res.status, JSON.stringify(json ?? text.slice(0, 300)).slice(0, 500));
  return { status: res.status, json, text };
}

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

const session = await call('POST', '/sessions/', sessionBody);
if (session.status !== 200 || !session.json?.id) {
  writeFileSync(join(OUT_DIR, 'whatsapp-otp-complete.json'), JSON.stringify({ phone, otp, log }, null, 2));
  process.exit(1);
}

const token = session.json.id;
const identifier = session.json.identifier || phone;
const partnerExternalId = session.json.partnerExternalId;
const auth = { Authorization: `claro ${token}`, Channel: 'whatsapp' };

const endpoints = [
  ['GET', `/sessions/${identifier}/tmp/token`],
  ['GET', `/customers/${identifier}/products`],
  ['GET', `/customers/${identifier}/payment-methods`],
  ['GET', `/customers/${identifier}/recharges`],
  ['GET', `/customers/${identifier}/recharges?reloadType=recurring`],
  ['POST', `/customers/${identifier}/smartcheckout/v2/url`, { channel: ['whatsapp', 'CLARO_WHATSAPP'], msisdn: identifier }],
  ['POST', '/recharges/encrypted', { payload: 'placeholder' }],
  ['POST', '/loop/public/events', {
    type: 'pageview',
    msisdn: identifier,
    session_id: token,
    tags: { portal: 'claro_whatsapp', realm: 'claro_recarga', page_name: 'landing_page' },
  }],
];

for (const [method, path, body, extra] of endpoints) {
  try {
    await call(method, path, body, { ...auth, ...(extra || {}) });
  } catch (err) {
    log.push({ method, path, error: String(err) });
    console.error(method, path, err.message);
  }
}

writeFileSync(join(OUT_DIR, 'whatsapp-otp-complete.json'), JSON.stringify({
  phone,
  otp,
  session: session.json,
  authHeader: `claro ${token}`,
  partnerExternalId,
  identifier,
  log,
}, null, 2));
