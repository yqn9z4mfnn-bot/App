import { insertRechargeEvent, listRechargeEvents } from './admin-db.mjs';

const META_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(R\$\s*[\d.,]+)\s+(\d+)\s*->\s*(\d+)\s+(SUCCESS|CONFIRMED)\b/i;

export function parseApprovedLine(line) {
  const raw = String(line ?? '').trim();
  if (!raw || raw.startsWith('#')) return null;
  const hash = raw.indexOf('#');
  const cardPart = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
  const metaPart = hash >= 0 ? raw.slice(hash + 1).trim() : '';
  const pan = cardPart.split('|')[0]?.replace(/\D/g, '') ?? '';
  if (pan.length < 13 || pan.length > 19) return null;
  const parsed = {
    last4: pan.slice(-4),
    productName: null,
    productValueCents: null,
    loginMsisdn: null,
    targetMsisdn: null,
    createdAt: null,
    ok: false,
  };
  if (!metaPart) return parsed;
  const m = metaPart.match(META_RE);
  if (!m) return parsed;
  parsed.createdAt = Date.parse(`${m[1].replace(' ', 'T')}Z`);
  parsed.productName = m[2].replace(/\s+/g, '');
  parsed.productValueCents = brlToCents(m[2]);
  parsed.loginMsisdn = m[3];
  parsed.targetMsisdn = m[4];
  parsed.ok = Number.isFinite(parsed.createdAt);
  return parsed;
}

function brlToCents(text) {
  const n = String(text)
    .replace(/R\$\s*/i, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

export function backfillApprovedRecharges(approvedLines) {
  const existing = new Set();
  for (const row of listRechargeEvents({ limit: 5000 })) {
    if (row.status === 'success' && row.card_last4) existing.add(String(row.card_last4));
  }

  let inserted = 0;
  let skipped = 0;
  for (const line of approvedLines) {
    const parsed = parseApprovedLine(line);
    if (!parsed?.ok) {
      skipped += 1;
      continue;
    }
    if (existing.has(parsed.last4)) {
      skipped += 1;
      continue;
    }
    insertRechargeEvent({
      createdAt: parsed.createdAt,
      loginMsisdn: parsed.loginMsisdn,
      targetMsisdn: parsed.targetMsisdn,
      productName: parsed.productName,
      productValueCents: parsed.productValueCents,
      cardLast4: parsed.last4,
      status: 'success',
      gateCode: 'CONFIRMED',
      gateMessage: 'Pagamento confirmado',
      mode: 'backfill-approved',
    });
    existing.add(parsed.last4);
    inserted += 1;
  }
  return { inserted, skipped, approved: approvedLines.length };
}
