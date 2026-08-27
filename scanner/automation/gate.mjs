import { sleep } from './helpers.mjs';

const GATE_URL_RE =
  /eldorado\.m4u|claro-recarga-api|\/recharges\/result|\/loop\/events|\/api\/v1\/payments|wallet|card/i;

const parseSseJson = (text) => {
  const line = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('data:'));
  if (!line) return null;
  const raw = line.replace(/^data:\s*/, '');
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const pickGateFields = (body) => {
  if (!body || typeof body !== 'object') return { code: null, message: null };
  const pay0 = Array.isArray(body.payments) ? body.payments[0] : null;
  if (/^DENIED$/i.test(String(body.status || pay0?.status || ''))) {
    return {
      code: pay0?.standardCode || 'DENIED',
      message: pay0?.negativeReason || body.negativeReason || body.message || null,
    };
  }
  if (/^CONFIRMED$/i.test(String(body.status || pay0?.status || ''))) {
    return { code: 'CONFIRMED', message: body.message || 'Pagamento confirmado' };
  }
  if (Array.isArray(body) && body[0]?.status === 'ok' && body[0]?.paymentMethod?.nsu) {
    return { code: 'OK', message: 'Recarga confirmada' };
  }
  return { code: body.status || null, message: body.message || null };
};

export const attachGateCapture = (context) => {
  const captures = [];
  const onResponse = async (response) => {
    try {
      const url = response.url();
      if (!GATE_URL_RE.test(url)) return;
      let body = null;
      try {
        body = await response.json();
      } catch {
        try {
          const text = await response.text();
          if (text.startsWith('{') || text.startsWith('[')) body = JSON.parse(text);
          else if (text.startsWith('data:')) body = parseSseJson(text) || { _raw: text.slice(0, 2000) };
        } catch {
          return;
        }
      }
      if (!body) return;
      captures.push({
        ts: Date.now(),
        url,
        httpStatus: response.status(),
        body,
      });
      if (captures.length > 40) captures.splice(0, captures.length - 40);
    } catch {
      // ignore
    }
  };
  context.on('response', onResponse);
  return {
    captures,
    detach: () => {
      try {
        context.off('response', onResponse);
      } catch {
        // ignore
      }
    },
    best: () => {
      if (!captures.length) return null;
      const rank = (c) => {
        let r = 0;
        const b = c.body;
        const u = c.url || '';
        if (/\/payments/i.test(u) && (b?.status === 'CONFIRMED' || b?.payments?.[0]?.status === 'CONFIRMED')) r += 40;
        if (/\/payments/i.test(u) && (b?.status === 'DENIED' || b?.payments?.[0]?.status === 'DENIED')) r += 32;
        if (Array.isArray(b) && b[0]?.status === 'ok') r += 22;
        return r * 1e6 + c.ts;
      };
      return [...captures].sort((a, b) => rank(b) - rank(a))[0];
    },
  };
};

export const gateIndicatesSuccess = (gateResponse) => {
  const b = gateResponse?.body;
  if (!b) return false;
  if (/^CONFIRMED$/i.test(String(b.status || ''))) return true;
  if (b.payments?.[0]?.status === 'CONFIRMED') return true;
  if (Array.isArray(b) && b[0]?.status === 'ok' && b[0]?.paymentMethod?.nsu) return true;
  return false;
};

export const gateIndicatesError = (gateResponse) => {
  const b = gateResponse?.body;
  if (!b) return false;
  if (/^DENIED$/i.test(String(b.status || ''))) return true;
  if (b.payments?.[0]?.status === 'DENIED') return true;
  if (Array.isArray(b) && b[0]?.status === 'nok') return true;
  return false;
};

const buildPaymentResult = (page, status, url, gateCapture, hint = '') => {
  const best = gateCapture?.best?.() || null;
  const fields = best ? pickGateFields(best.body) : { code: null, message: null };
  return {
    status,
    url,
    gateResponse: best,
    gateCode: fields.code,
    gateMessage: fields.message || hint || null,
    pagamentoErro: status === 'error',
    message: fields.message || hint || status,
  };
};

export const waitForPaymentResult = async (page, timeoutMs = 120000, gateCapture = null) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    const best = gateCapture?.best?.() || null;
    if (best && gateIndicatesSuccess(best)) {
      return buildPaymentResult(page, 'success', url, gateCapture);
    }
    if (best && gateIndicatesError(best)) {
      return buildPaymentResult(page, 'error', url, gateCapture);
    }
    if (/pagamento-sucesso|confirmacao-beneficio/i.test(url)) {
      return buildPaymentResult(page, 'success', url, gateCapture);
    }
    if (/pagamento-erro/i.test(url)) {
      return buildPaymentResult(page, 'error', url, gateCapture);
    }
    const bodyText = await page
      .locator('body')
      .innerText({ timeout: 3000 })
      .catch(() => '');
    if (/recarga realizada|pagamento aprovado|sucesso/i.test(bodyText)) {
      return buildPaymentResult(page, 'success', url, gateCapture, bodyText.slice(0, 200));
    }
    if (/recusad|negad|não foi possível|nao foi possivel/i.test(bodyText)) {
      return buildPaymentResult(page, 'error', url, gateCapture, bodyText.slice(0, 200));
    }
    await sleep(500);
  }
  return buildPaymentResult(page, 'timeout', page.url(), gateCapture, 'Timeout aguardando gate');
};
