import { request } from './http.mjs';
import { proxiedFetch } from './proxy.mjs';
import { openWalletSession } from './eldorado.mjs';
import { buildBrowserPaymentExtras } from './antifraud-payload.mjs';
import { formatCardMask } from './card-parse.mjs';

const ELDORADO = 'https://eldorado.m4u.com.br';

function eldoradoHeaders(bemobiToken, checkoutCode, extra = {}) {
  return {
    authorization: `Bearer ${bemobiToken}`,
    'x-bsc': 'client',
    'x-session-id': checkoutCode,
    accept: 'application/json',
    'content-type': 'application/json',
    ...extra,
  };
}

export async function getInstallments(bemobiToken, checkoutCode, invoiceId) {
  const q = new URLSearchParams({
    method: 'credit',
    currency: 'BRL',
    invoice_ids: invoiceId,
  });
  return request(`${ELDORADO}/api-bsc/api/v1/installments?${q}`, {
    headers: eldoradoHeaders(bemobiToken, checkoutCode),
  });
}

export async function tokenizeCard(checkoutCode, card) {
  const pan = card.number.replace(/\D/g, '');
  let mm;
  let year;

  if (card.expirationMonth && card.expirationYear) {
    mm = String(card.expirationMonth).padStart(2, '0');
    year = String(card.expirationYear);
  } else {
    const [m, y] = card.expiry.includes('/')
      ? card.expiry.split('/')
      : [card.expiry.slice(0, 2), card.expiry.slice(2)];
    mm = m.padStart(2, '0');
    year = y.length === 2 ? `20${y}` : y;
  }

  return request(`${ELDORADO}/tokenizer/validation`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-session-id': checkoutCode,
      accept: 'application/json',
    },
    body: JSON.stringify({
      card_number: pan,
      cvv: card.cvv,
      expiration_month: mm.padStart(2, '0'),
      expiration_year: year,
      holder_name: card.holder,
      holder_document: '',
      partner: 'MINHA-CLARO-WEB',
      payment_type: 'credit',
      perform_zero_auth: false,
    }),
  });
}

export async function lookupBin(bin6) {
  return request(`${ELDORADO}/v1/bins/${bin6}`, {
    headers: { accept: 'application/json' },
  });
}

export async function createPayment(bemobiToken, checkoutCode, payload) {
  return request(`${ELDORADO}/api-bsc/api/v1/payments`, {
    method: 'POST',
    headers: eldoradoHeaders(bemobiToken, checkoutCode),
    body: JSON.stringify(payload),
  });
}

/** Lê SSE até status final ou timeout. */
export async function waitPaymentResult(bemobiToken, paymentId, timeoutMs = 55000) {
  const url = `${ELDORADO}/api-bsc/api/v1/payments/${paymentId}/sse`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await proxiedFetch(url, {
      headers: {
        authorization: `Bearer ${bemobiToken}`,
        'x-bsc': 'client',
        accept: 'text/event-stream',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`SSE HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastEvent = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const block of parts) {
        for (const line of block.split('\n')) {
          if (line.startsWith('data:')) {
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            try {
              lastEvent = JSON.parse(raw);
              const st = lastEvent.status?.toUpperCase?.() ?? lastEvent.status;
              if (st && !['PENDING', 'PROCESSING'].includes(st)) {
                return lastEvent;
              }
            } catch {
              /* ignore partial json */
            }
          }
        }
      }
    }

    return lastEvent ?? { status: 'TIMEOUT', message: 'Sem resposta SSE' };
  } finally {
    clearTimeout(timer);
  }
}

function parseExpiry(expiry, fallbackMonth, fallbackYear) {
  if (expiry) {
    const [mm, yy] = expiry.includes('/')
      ? expiry.split('/')
      : [expiry.slice(0, 2), expiry.slice(2)];
    const year = Number(yy.length === 2 ? `20${yy}` : yy);
    return { month: Number(mm), year };
  }
  return { month: fallbackMonth, year: fallbackYear };
}

/**
 * Executa recarga com cartão novo ou salvo na wallet.
 * @param {object} opts
 * @param {string} opts.sessionId - claro session id
 * @param {string} opts.msisdn
 * @param {string} opts.productId
 * @param {object} opts.card - { number, holder, expiry, cvv } ou { token, cvv, brand, bin, last, expirationMonth, expirationYear, holder, wasSaved }
 */
export async function runRecharge({
  sessionId,
  msisdn,
  productId,
  productValue,
  card,
  existingCheckout = null,
}) {
  const started = Date.now();

  let checkoutCode;
  let bemobiToken;
  let invoiceId;
  let bemobiBody;

  if (existingCheckout?.bemobiToken && existingCheckout?.checkoutCode) {
    checkoutCode = existingCheckout.checkoutCode;
    bemobiToken = existingCheckout.bemobiToken;
    invoiceId = existingCheckout.invoiceId;
    bemobiBody = existingCheckout.bemobiBody;
  } else {
    const wallet = await openWalletSession(sessionId, msisdn, productId);
    if (wallet.error) {
      throw new Error(wallet.message ?? wallet.error);
    }
    checkoutCode = wallet.checkoutCode;
    bemobiToken = wallet.bemobiToken;
    bemobiBody = wallet.bemobi.body;
    invoiceId = bemobiBody?.invoices?.[0]?.id;
    if (!invoiceId) {
      throw new Error('Invoice não encontrada na sessão checkout');
    }
  }

  const instRes = await getInstallments(bemobiToken, checkoutCode, invoiceId);
  if (instRes.status !== 200) {
    throw new Error(`Installments falhou (${instRes.status})`);
  }

  let cardPayload;
  const isSaved = Boolean(card.token);

  if (isSaved) {
    const { month, year } = parseExpiry(card.expiry, card.expirationMonth, card.expirationYear);
    cardPayload = {
      token: card.token,
      expirationYear: year,
      expirationMonth: month,
      cvv: card.cvv,
      brand: card.brand,
      bin: card.bin,
      last: card.last,
      holder: {
        name: card.holder?.name ?? card.holder ?? '',
        email: '',
        phoneNumber: '',
      },
      paymentWallet: 'bemobi',
      wasSaved: true,
      length: 16,
    };
  } else {
    const pan = card.number.replace(/\D/g, '');
    const tokRes = await tokenizeCard(checkoutCode, card);
    if (tokRes.status !== 200 && tokRes.status !== 201) {
      const msg =
        typeof tokRes.body === 'object' ? JSON.stringify(tokRes.body) : tokRes.body;
      throw new Error(`Tokenização falhou (${tokRes.status}): ${msg}`);
    }

    const cardToken = tokRes.body?.card_token;
    if (!cardToken) throw new Error('Token do cartão não retornado');

    const bin = pan.slice(0, 6);
    const binRes = await lookupBin(bin);
    const brand = binRes.body?.brand ?? binRes.body?.name ?? 'VISA';

    const [mm, yy] = card.expiry?.includes('/')
      ? card.expiry.split('/')
      : [
          String(card.expirationMonth ?? '').padStart(2, '0'),
          String(card.expirationYear ?? '').slice(-2),
        ];
    const year = card.expirationYear ?? Number(yy.length === 2 ? `20${yy}` : yy);

    cardPayload = {
      token: cardToken,
      expirationYear: year,
      expirationMonth: Number(mm),
      cvv: card.cvv,
      brand: String(brand).toUpperCase(),
      bin,
      last: pan.slice(-4),
      holder: { name: card.holder, email: '', phoneNumber: '' },
      paymentWallet: 'bemobi',
      wasSaved: false,
      threeDSecure: {
        xid: '',
        eci: '',
        version: '',
        referenceId: '',
        cavv: '',
        tdsdsxid: '',
      },
      length: pan.length,
    };
  }

  const paymentPayload = {
    method: 'credit',
    installments: 1,
    card: cardPayload,
    ...buildBrowserPaymentExtras({ invoiceId, isSaved }),
  };

  const payRes = await createPayment(bemobiToken, checkoutCode, paymentPayload);

  if (payRes.status === 429) {
    throw new Error('Rate limit no pagamento (429) — aguarde e tente novamente');
  }
  if (payRes.status !== 200 && payRes.status !== 201) {
    const msg = typeof payRes.body === 'object' ? JSON.stringify(payRes.body) : payRes.body;
    throw new Error(`Pagamento falhou (${payRes.status}): ${msg}`);
  }

  const paymentId = payRes.body?.id;
  if (!paymentId) throw new Error('ID do pagamento não retornado');

  const sse = await waitPaymentResult(bemobiToken, paymentId);

  return {
    paymentId,
    pending: payRes.body,
    result: sse,
    valueCents: productValue ?? bemobiBody?.invoices?.[0]?.value,
    latencyMs: Date.now() - started,
    cardMask: isSaved
      ? (card.bin ? `${card.bin}****${card.last}` : `****${card.last}`)
      : formatCardMask(card.number),
  };
}
