import { sleep } from './helpers.mjs';
import { config } from './config.mjs';
import { saveStallDebug, summarizeGateBody, summarizeGateCaptures } from './debug.mjs';
import { detect3dsChallenge, build3dsRequiredResult } from './threeds.mjs';

const GATE_URL_RE =
  /eldorado\.m4u|claro-recarga-api|\/recharges\/result|\/loop\/events|\/api\/v1\/payments|wallet|card/i;

const PAYMENT_ERROR_TEXT_RE =
  /n[aã]o conseguimos processar|n[aã]o foi poss[ií]vel processar|pagamento recusad|transa[cç][aã]o negad|cart[aã]o recusad|algo deu errado/i;
const PAYMENT_SUCCESS_TEXT_RE =
  /recarga realizada|pagamento aprovad|recarga efetuada|sucesso na recarga|obrigado pela recarga|pronto!\s*sua recarga/i;

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
  const loopSt = body.tags?.transaction?.status ?? body.tags?.status;
  if (loopSt) {
    return {
      code: String(loopSt),
      message: body.tags?.transaction?.reason || body.message || null,
    };
  }
  return { code: body.status || null, message: body.message || null };
};

const logGateCapture = (cap) => {
  const sum = summarizeGateBody(cap.body);
  console.log(
    `[automation][gate] http=${cap.httpStatus} status=${sum?.status ?? '?'} ` +
      `url=${String(cap.url).slice(0, 100)} ` +
      (sum?.negativeReason ? `reason=${String(sum.negativeReason).slice(0, 80)} ` : '') +
      (sum?.loopReason ? `loop=${String(sum.loopReason).slice(0, 80)} ` : ''),
  );
};

export const hasSmartCheckoutApiCall = (gateCapture, sinceTs = 0) =>
  (gateCapture?.captures ?? []).some(
    (c) =>
      c.ts >= sinceTs &&
      /smartcheckout\/v2\/url/i.test(c.url || '') &&
      c.httpStatus >= 200 &&
      c.httpStatus < 300,
  );

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
      const cap = {
        ts: Date.now(),
        url,
        httpStatus: response.status(),
        body,
      };
      captures.push(cap);
      if (captures.length > 40) captures.splice(0, captures.length - 40);
      logGateCapture(cap);
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
        if (/\/loop\/events/i.test(u) && b?.tags?.transaction?.status === 'DENIED') r += 28;
        if (Array.isArray(b) && b[0]?.status === 'ok') r += 22;
        if (/\/payments/i.test(u) && /^PENDING$/i.test(String(b?.status || b?.payments?.[0]?.status || ''))) r += 5;
        return r * 1e6 + c.ts;
      };
      return [...captures].sort((a, b) => rank(b) - rank(a))[0];
    },
    tail: (n = 8) => summarizeGateCaptures({ captures }, n),
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
  if (String(b.tags?.transaction?.status || '').toUpperCase() === 'DENIED') return true;
  return false;
};

const scanPageForPaymentOutcome = async (page) => {
  for (const frame of page.frames()) {
    try {
      const text = await frame.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim());
      if (!text) continue;
      if (PAYMENT_ERROR_TEXT_RE.test(text)) {
        return { status: 'error', hint: text.slice(0, 500), frameUrl: frame.url() };
      }
      if (PAYMENT_SUCCESS_TEXT_RE.test(text)) {
        return { status: 'success', hint: text.slice(0, 500), frameUrl: frame.url() };
      }
    } catch {
      // cross-origin
    }
  }
  try {
    const text = (await page.locator('body').innerText({ timeout: 1500 })).replace(/\s+/g, ' ').trim();
    if (PAYMENT_ERROR_TEXT_RE.test(text)) return { status: 'error', hint: text.slice(0, 500), frameUrl: page.url() };
    if (PAYMENT_SUCCESS_TEXT_RE.test(text)) return { status: 'success', hint: text.slice(0, 500), frameUrl: page.url() };
  } catch {
    // ignore
  }
  return null;
};

const buildPaymentResult = (page, status, url, gateCapture, hint = '', debugInfo = null) => {
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
    debug: debugInfo,
  };
};

const logGateWaitHeartbeat = (elapsedMs, page, gateCapture, lastPending) => {
  const best = gateCapture?.best?.() || null;
  const sum = best ? summarizeGateBody(best.body) : null;
  const pending = sum?.status && /^PENDING$/i.test(String(sum.status));
  const pendingChanged = pending !== lastPending.value;
  lastPending.value = pending;

  console.log(
    `[automation][gate-wait] ${Math.round(elapsedMs / 1000)}s ` +
      `url=${(page.url() || '').slice(0, 90)} ` +
      `captures=${gateCapture?.captures?.length ?? 0} ` +
      `best_status=${sum?.status ?? 'none'} ` +
      (pending ? 'PENDING ' : '') +
      (sum?.negativeReason ? `reason=${String(sum.negativeReason).slice(0, 60)} ` : ''),
  );

  if (pendingChanged && pending) {
    console.log('[automation][gate-wait] ⚠ pagamento PENDING na gate — aguardando final…');
  }
};

export const waitForPaymentResult = async (page, timeoutMs = 120000, gateCapture = null, session = null) => {
  const start = Date.now();
  let lastHeartbeat = 0;
  const lastPending = { value: false };

  while (Date.now() - start < timeoutMs) {
    const elapsed = Date.now() - start;
    if (elapsed - lastHeartbeat >= 15000) {
      lastHeartbeat = elapsed;
      logGateWaitHeartbeat(elapsed, page, gateCapture, lastPending);
    }

    const url = page.url();
    const best = gateCapture?.best?.() || null;
    if (best && gateIndicatesSuccess(best)) {
      return buildPaymentResult(page, 'success', url, gateCapture);
    }
    if (best && gateIndicatesError(best)) {
      return buildPaymentResult(page, 'error', url, gateCapture);
    }

    const visible = await scanPageForPaymentOutcome(page);
    if (visible?.status === 'success' && !/pagamento-erro/i.test(url)) {
      return buildPaymentResult(page, 'success', url, gateCapture, visible.hint);
    }
    if (visible?.status === 'error' && !/pagamento-sucesso|confirmacao-beneficio/i.test(url)) {
      return buildPaymentResult(page, 'error', url, gateCapture, visible.hint);
    }

    if (/pagamento-sucesso|confirmacao-beneficio/i.test(url)) {
      return buildPaymentResult(page, 'success', url, gateCapture);
    }
    if (/pagamento-erro/i.test(url)) {
      return buildPaymentResult(page, 'error', url, gateCapture);
    }

    const threeDs = await detect3dsChallenge(page, gateCapture);
    if (threeDs?.detected) {
      return build3dsRequiredResult(page, session, gateCapture, threeDs, elapsed);
    }

    await sleep(config.pollIntervalMs);
  }

  const elapsed = Date.now() - start;
  const debugInfo = session
    ? await saveStallDebug(page, session, gateCapture, 'gate_timeout', {
        waitedMs: elapsed,
        timeoutMs,
        lastCaptures: gateCapture?.tail?.(12) ?? [],
      })
    : null;

  console.log(
    `[automation][gate-wait] TIMEOUT após ${Math.round(elapsed / 1000)}s — ` +
      'ver debug JSON/PNG em linkclaro-bot/debug/',
  );

  return buildPaymentResult(
    page,
    'timeout',
    page.url(),
    gateCapture,
    'Timeout aguardando gate',
    debugInfo
      ? { ...debugInfo.report, jsonPath: debugInfo.jsonPath, pngPath: debugInfo.pngPath }
      : null,
  );
};
