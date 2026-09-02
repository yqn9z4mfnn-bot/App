import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'output');
const BASE = 'https://claro-recarga-api.m4u.com.br';
const CC_BASE = 'https://eldorado.m4u.com.br';

const phone = process.argv[2];
const otp = process.argv[3];
const pan = process.env.CARD_PAN || process.argv[4];
const month = process.env.CARD_MONTH || process.argv[5];
const year = process.env.CARD_YEAR || process.argv[6];
const cvv = process.env.CARD_CVV || process.argv[7];
const valueCents = Number(process.argv[8] || 3500);
const productId = process.argv[9] || '08d6a618-5708-45a6-bb6d-7aaa9d6d107f';

if (!phone || !otp || !pan || !month || !year || !cvv) {
  console.error('Uso: CARD_* env ou');
  console.error('  node scripts/complete-recharge-credit.mjs <telefone> <otp> <pan> <mes> <ano> <cvv> [valor_centavos] [productId]');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const log = [];

async function call(method, path, body, headers = {}, formBody, base = BASE) {
  const url = path.startsWith('http') ? path : base + path;
  const h = { Accept: 'application/json', Channel: 'whatsapp', ...headers };
  const init = { method, headers: h };
  if (formBody) {
    init.body = formBody;
    h['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (body !== undefined && method !== 'GET') {
    h['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const entry = { method, url, status: res.status, requestBody: formBody || body || null, responseBody: json ?? text.slice(0, 15000) };
  log.push(entry);
  console.log(method, path, res.status, JSON.stringify(json ?? text.slice(0, 400)).slice(0, 600));
  return { status: res.status, json, text };
}

const session = await call('POST', '/sessions/', {
  msisdn: phone,
  data: otp,
  type: 'sms',
  channel: ['whatsapp', 'CLARO_WHATSAPP'],
  origin: 'landing',
  loading: true,
  loginAction: 'loginWithRechargeValue',
  loginValue: valueCents,
});

if (session.status !== 200 || !session.json?.id) {
  writeFileSync(join(OUT, 'recharge-credit-result.json'), JSON.stringify({ phone, log, error: 'session_failed' }, null, 2));
  process.exit(1);
}

const token = session.json.id;
const identifier = session.json.identifier || phone;
const auth = { Authorization: `claro ${token}` };

await call('GET', `/customers/${identifier}`, undefined, auth);

const ccBody = new URLSearchParams({ pan, month, year, partner: 'CLARO' }).toString();
const cc = await call('POST', '/v1/cc', undefined, auth, ccBody, CC_BASE);

if (cc.status !== 200 || !cc.json?.card?.key) {
  writeFileSync(join(OUT, 'recharge-credit-result.json'), JSON.stringify({ phone, session: session.json, log, error: 'tokenize_failed' }, null, 2));
  process.exit(1);
}

const cardToken = cc.json.card.key;
const lastDigits = cc.json.card.last;
const brandName = (cc.json.card.brand || 'unknown').replace(/^\w/, (c) => c.toUpperCase());

await call('GET', `/customers/${identifier}/products`, undefined, auth);
await call('GET', `/customers/${identifier}/payment-methods`, undefined, auth);

const rechargeBody = {
  targetMsisdn: identifier,
  rechargeValue: { id: productId, value: valueCents },
  paymentMethod: {
    type: 'credit',
    data: { token: cardToken, cvv, lastDigits, brandName },
  },
  frequency: null,
  tags: { repeatRecharge: 'false' },
};

const recharge = await call('POST', `/customers/${identifier}/recharges`, rechargeBody, {
  ...auth,
  'device-id': `cursor-agent-${Date.now()}`,
});

writeFileSync(join(OUT, 'recharge-credit-result.json'), JSON.stringify({
  phone,
  valueCents,
  productId,
  session: session.json,
  cardLastDigits: lastDigits,
  brandName,
  rechargeStatus: recharge.status,
  log,
}, null, 2));

process.exit(recharge.status >= 200 && recharge.status < 300 ? 0 : 1);
