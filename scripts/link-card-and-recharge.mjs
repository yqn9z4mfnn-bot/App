import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'output');
const API = 'https://claro-recarga-api.m4u.com.br';
const CC = 'https://eldorado.m4u.com.br';

const phone = process.argv[2];
const otp = process.argv[3];
const pan = process.env.CARD_PAN || process.argv[4];
const month = process.env.CARD_MONTH || process.argv[5];
const year = process.env.CARD_YEAR || process.argv[6];
const cvv = process.env.CARD_CVV || process.argv[7] || '0000';
const valueCents = Number(process.argv[8] || 3500);
const productId = process.argv[9] || '08d6a618-5708-45a6-bb6d-7aaa9d6d107f';

if (!phone || !otp || !pan || !month || !year) {
  console.error('Uso: node scripts/link-card-and-recharge.mjs <telefone> <otp> <pan> <mes> <ano> [cvv] [valor_centavos]');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const log = [];

async function call(method, path, { body, formBody, headers = {}, base = API } = {}) {
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
  log.push({ method, url, status: res.status, requestBody: formBody || body || null, responseBody: json ?? text.slice(0, 15000) });
  console.log(method, url.replace(base, ''), res.status, JSON.stringify(json ?? text.slice(0, 300)).slice(0, 500));
  return { status: res.status, json, text };
}

console.log('=== 1) Login OTP ===');
const session = await call('POST', '/sessions/', {
  body: {
    msisdn: phone,
    data: otp,
    type: 'sms',
    channel: ['whatsapp', 'CLARO_WHATSAPP'],
    origin: 'landing',
    loading: true,
    loginAction: 'loginWithRechargeValue',
    loginValue: valueCents,
  },
});
if (session.status !== 200 || !session.json?.id) process.exit(1);

const auth = { Authorization: `claro ${session.json.id}` };
const identifier = session.json.identifier || phone;

console.log('=== 2) Tokenizar cartão (Eldorado) ===');
const ccForm = new URLSearchParams({ pan, month, year, partner: 'CLARO' }).toString();
const cc = await call('POST', '/v1/cc', { formBody: ccForm, base: CC });
if (cc.status !== 200 || !cc.json?.card?.key) process.exit(1);

const cardKey = cc.json.card.key;
const lastDigits = cc.json.card.last;
const brandName = (cc.json.card.brand || 'unknown').replace(/^\w/, (c) => c.toUpperCase());

console.log('=== 3) Vincular cartão na conta ===');
const link = await call('POST', `/customers/${identifier}/payment-methods`, {
  body: { type: 'credit', data: { token: cardKey } },
  headers: auth,
});
// 200/201 expected; continue even on duplicate

console.log('=== 4) Listar meios de pagamento ===');
const methods = await call('GET', `/customers/${identifier}/payment-methods`, { headers: auth });

let savedToken = cardKey;
const credit = methods.json?.find?.((m) => m.type === 'credit');
const saved = credit?.elements?.find?.((el) => el.data?.token || el.token);
if (saved?.data?.token) savedToken = saved.data.token;
else if (saved?.token) savedToken = saved.token;

console.log('=== 5) Recarga R$', valueCents / 100, 'com cartão vinculado + CVV ===');
const recharge = await call('POST', `/customers/${identifier}/recharges`, {
  body: {
    targetMsisdn: identifier,
    rechargeValue: { id: productId, value: valueCents },
    paymentMethod: {
      type: 'credit',
      data: { token: savedToken, cvv, lastDigits, brandName },
    },
    frequency: null,
    tags: { repeatRecharge: 'false' },
  },
  headers: { ...auth, 'device-id': `cursor-link-pay-${Date.now()}` },
});

console.log('=== 6) Histórico de recargas ===');
await call('GET', `/customers/${identifier}/recharges`, { headers: auth });

if (recharge.json?.transactionId || recharge.json?.id) {
  const tx = recharge.json.transactionId || recharge.json.partnerExternalId || recharge.json.id;
  await call('GET', `/customers/${identifier}/recharges/result/${tx}`, { headers: auth });
}

writeFileSync(join(OUT, 'link-card-recharge-result.json'), JSON.stringify({
  phone,
  valueCents,
  session: session.json,
  cardLinked: link.status,
  cardLastDigits: lastDigits,
  brandName,
  paymentMethods: methods.json,
  rechargeStatus: recharge.status,
  rechargeBody: recharge.json,
  log,
}, null, 2));

process.exit(recharge.status >= 200 && recharge.status < 300 ? 0 : 1);
