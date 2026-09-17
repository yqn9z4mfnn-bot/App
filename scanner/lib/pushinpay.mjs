const DEFAULT_BASE = 'https://api.pushinpay.com.br';

function apiBase() {
  return String(process.env.PUSHINPAY_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
}

function bearerToken() {
  const t = String(process.env.PUSHINPAY_TOKEN || '').trim();
  if (!t) throw new Error('PUSHINPAY_TOKEN não configurado');
  return t;
}

export function pushinPayConfigured() {
  return Boolean(String(process.env.PUSHINPAY_TOKEN || '').trim());
}

/**
 * @param {{ valueCents: number, webhookUrl?: string, description?: string }} opts
 */
export async function createPixCashIn({ valueCents, webhookUrl, description }) {
  const value = Math.round(Number(valueCents));
  if (!Number.isFinite(value) || value < 50) {
    throw new Error('Valor mínimo do PIX: R$ 0,50 (50 centavos)');
  }
  const body = {
    value,
    split_rules: [],
  };
  if (webhookUrl) body.webhook_url = webhookUrl;
  if (description) body.description = String(description).slice(0, 255);

  const res = await fetch(`${apiBase()}/api/pix/cashIn`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerToken()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      data?.message ||
      data?.error ||
      (typeof data?.raw === 'string' ? data.raw.slice(0, 200) : null) ||
      `HTTP ${res.status}`;
    throw new Error(`PushinPay: ${msg}`);
  }
  return data;
}
