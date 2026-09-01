import { sleep } from './helpers.mjs';
import { config, threedsStopOnVbvEnabled } from './config.mjs';
import { saveStallDebug, summarizeGateBody, summarizeGateCaptures } from './debug.mjs';
import {
  detect3dsChallenge,
  build3dsRequiredResult,
  get3dsChallengeApiCapture,
  threedsRequiresImmediateAction,
} from './threeds.mjs';
import { absorbCheckoutCtxFromCapture, createCheckoutCtx } from './card-cleanup.mjs';
import { waitPaymentResult as waitHttpPaymentSse } from '../lib/recharge.mjs';
import {
  CHECKOUT_ERROR_TEXT_RE,
  CHECKOUT_SUCCESS_TEXT_RE,
  checkoutErrorHint,
  isCheckoutErrorUrl,
  isCheckoutSuccessUrl,
  overrideThreedsIfCheckoutError,
} from '../lib/checkout-error.mjs';

const GATE_URL_RE =
  /eldorado\.m4u|claro-recarga-api|bemobi\.com|smart-checkout|\/recharges\/result|\/loop\/events|\/api\/v1\/payments|\/tokenizer\/|wallet|card/i;

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
    return { code: 'OK', message: 'Recarga confirmada (aguardando CONFIRMED)' };
  }
  const loopSt = body.tags?.transaction?.status ?? body.tags?.status;
  if (loopSt) {
    return {
      code: String(loopSt),
      message: body.tags?.transaction?.reason || body.message || null,
    };
  }
  if (body.exception?.message) {
    return {
      code: body.status || body.exception?.name || 'ERROR',
      message: String(body.exception.message).split('\n')[0].slice(0, 500),
    };
  }
  if (body.error?.message) {
    return {
      code: body.status || body.error?.code || 'ERROR',
      message: String(body.error.message).slice(0, 500),
    };
  }
  if (body.message) {
    return { code: body.status || body.code || null, message: String(body.message).slice(0, 500) };
  }
  return { code: body.status || null, message: null };
};

/** Última captura relevante de erro (422, DENIED, 502 Braspag…). */
export const findBestGateErrorCapture = (gateCapture) => {
  const list = gateCapture?.captures ?? [];
  const ranked = list
    .map((c) => {
      let score = 0;
      const u = c.url || '';
      const b = c.body;
      if (c.httpStatus >= 400) score += 50;
      if (/\/recharges/i.test(u) && c.httpStatus === 422) score += 40;
      if (/braspag/i.test(u)) score += 35;
      if (gateIndicatesError(c)) score += 30;
      if (b?.negativeReason || b?.payments?.[0]?.negativeReason) score += 25;
      return { c, score: score * 1e6 + c.ts };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.c ?? null;
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
  const checkoutCtx = createCheckoutCtx();
  const waiters = new Set();
  const state = { confirmed: null, denied: null };

  const wakeWaiters = () => {
    for (const fn of waiters) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
    waiters.clear();
  };

  const waitSignal = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(onWake);
        resolve('timeout');
      }, Math.max(20, ms));
      const onWake = () => {
        clearTimeout(timer);
        resolve('signal');
      };
      waiters.add(onWake);
    });

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
      absorbCheckoutCtxFromCapture(checkoutCtx, cap);
      captures.push(cap);
      if (captures.length > 80) captures.splice(0, captures.length - 80);
      logGateCapture(cap);
      if (gateIndicatesSuccess(cap)) {
        state.confirmed = cap;
        wakeWaiters();
      } else if (gateIndicatesError(cap)) {
        state.denied = cap;
        wakeWaiters();
      }
    } catch {
      // ignore
    }
  };
  context.on('response', onResponse);
  return {
    captures,
    checkoutCtx,
    get confirmed() {
      return state.confirmed;
    },
    get denied() {
      return state.denied;
    },
    waitSignal,
    detach: () => {
      try {
        context.off('response', onResponse);
      } catch {
        // ignore
      }
      wakeWaiters();
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
  const u = gateResponse?.url || '';
  if (!/\/payments/i.test(u)) return false;
  if (/^CONFIRMED$/i.test(String(b.status || ''))) return true;
  if (b.payments?.[0]?.status === 'CONFIRMED') return true;
  return false;
};

/** Última captura Eldorado /payments com status CONFIRMED. */
export const findConfirmedPaymentCapture = (gateCapture) => {
  const list = gateCapture?.captures ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const c = list[i];
    if (gateIndicatesSuccess(c)) return c;
  }
  return null;
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
      if (CHECKOUT_SUCCESS_TEXT_RE.test(text)) {
        return { status: 'success', hint: text.slice(0, 500), frameUrl: frame.url() };
      }
      if (CHECKOUT_ERROR_TEXT_RE.test(text)) {
        return { status: 'error', hint: text.slice(0, 500), frameUrl: frame.url() };
      }
    } catch {
      // cross-origin
    }
  }
  try {
    const text = (await page.locator('body').innerText({ timeout: 400 })).replace(/\s+/g, ' ').trim();
    if (CHECKOUT_SUCCESS_TEXT_RE.test(text)) return { status: 'success', hint: text.slice(0, 500), frameUrl: page.url() };
    if (CHECKOUT_ERROR_TEXT_RE.test(text)) return { status: 'error', hint: text.slice(0, 500), frameUrl: page.url() };
  } catch {
    // ignore
  }
  return null;
};

const takeCheckoutErrorResult = async (page, gateCapture, url = '') => {
  const pageUrl = url || (() => {
    try {
      return page?.url?.() ?? '';
    } catch {
      return '';
    }
  })();
  if (!isCheckoutErrorUrl(pageUrl)) {
    const visible = await scanPageForPaymentOutcome(page);
    if (visible?.status !== 'error') return null;
    return buildPaymentResult(
      page,
      'error',
      visible.frameUrl || pageUrl,
      gateCapture,
      checkoutErrorHint(visible.hint),
    );
  }
  const visible = await scanPageForPaymentOutcome(page);
  return buildPaymentResult(
    page,
    'error',
    pageUrl,
    gateCapture,
    checkoutErrorHint(visible?.hint, 'Não foi possível concluir o pagamento'),
  );
};

const buildPaymentResult = (page, status, url, gateCapture, hint = '', debugInfo = null) => {
  const errCap = status === 'error' ? findBestGateErrorCapture(gateCapture) : null;
  const best = errCap || gateCapture?.best?.() || null;
  const fields = best ? pickGateFields(best.body) : { code: null, message: null };
  return {
    status,
    url,
    gateResponse: best,
    gateCode: fields.code ?? best?.httpStatus ?? null,
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

export const waitForPaymentResult = async (page, timeoutMs = 120000, gateCapture = null, session = null, opts = {}) => {
  const start = Date.now();
  let lastHeartbeat = 0;
  let lastUiScan = 0;
  let challengeApiFirstSeen = null;
  let threedsWaitLogged = false;
  const lastPending = { value: false };
  const pollMs = opts.pollMs ?? config.pollIntervalMs;

  const takeConfirmed = () =>
    gateCapture?.confirmed || findConfirmedPaymentCapture(gateCapture);
  const takeDenied = () =>
    gateCapture?.denied ||
    ((gateCapture?.best?.() && gateIndicatesError(gateCapture.best())) ? gateCapture.best() : null);

  while (Date.now() - start < timeoutMs) {
    const elapsed = Date.now() - start;
    if (elapsed - lastHeartbeat >= 15000) {
      lastHeartbeat = elapsed;
      logGateWaitHeartbeat(elapsed, page, gateCapture, lastPending);
    }

    const url = page.url();
    const confirmed = takeConfirmed();
    if (confirmed) {
      console.log('[automation][gate] CONFIRMED na captura — respondendo agora');
      return buildPaymentResult(page, 'success', url, { ...gateCapture, best: () => confirmed });
    }
    if (isCheckoutSuccessUrl(url)) {
      console.log('[automation][gate] checkout/success — tratando como CONFIRMED');
      return buildPaymentResult(page, 'success', url, gateCapture, 'Pagamento confirmado');
    }

    const denied = takeDenied();
    if (denied) {
      return buildPaymentResult(page, 'error', url, gateCapture);
    }

    const checkoutError = await takeCheckoutErrorResult(page, gateCapture, url);
    if (checkoutError) {
      console.log(`[automation][gate] checkout/error — ${String(checkoutError.gateMessage || '').slice(0, 80)}`);
      return checkoutError;
    }

    const apiCap = get3dsChallengeApiCapture(gateCapture);
    if (apiCap && challengeApiFirstSeen == null) {
      challengeApiFirstSeen = apiCap.ts || Date.now();
    }
    if (challengeApiFirstSeen != null && !threedsWaitLogged) {
      threedsWaitLogged = true;
      console.log(
        `[automation][3ds] API challenge — vendo se abre VBV (até ${Math.round((config.threedsUiWaitMs || 8000) / 1000)}s)…`,
      );
    }

    const now = Date.now();
    const shouldScanUi = now - lastUiScan >= 400;
    if (shouldScanUi) {
      lastUiScan = now;
      const threeDs = await detect3dsChallenge(page, gateCapture, {
        challengeApiFirstSeen,
        threedsUiWaitMs: config.threedsUiWaitMs,
      });
      if (takeConfirmed()) {
        console.log('[automation][gate] CONFIRMED durante scan 3DS — respondendo agora');
        return buildPaymentResult(page, 'success', page.url(), {
          ...gateCapture,
          best: () => takeConfirmed(),
        });
      }
      if (threeDs?.detected) {
        const stopNow = threedsStopOnVbvEnabled() && threedsRequiresImmediateAction(threeDs);
        if (session && !session.threeDsSeen) {
          session.threeDsSeen = threeDs;
          session.threeDsSeenAt = Date.now();
          if (stopNow) {
            console.log('[automation][3ds] VBV visual — parando na hora');
          } else {
            console.log('[automation][3ds] detectado — continuando gate-wait (sem parar no VBV)');
          }
        }
        if (!threedsStopOnVbvEnabled()) {
          const extraMs = config.threedsExtraWaitMs ?? 12000;
          if (session?.threeDsSeenAt && Date.now() - session.threeDsSeenAt > extraMs) {
            const pageUrl = page.url();
            if (isCheckoutSuccessUrl(pageUrl)) {
              return buildPaymentResult(page, 'success', pageUrl, gateCapture, 'Pagamento confirmado');
            }
            const errNow = await takeCheckoutErrorResult(page, gateCapture);
            if (errNow) return errNow;
            console.log(
              `[automation][3ds] VBV sem confirmação após ${Math.round(extraMs / 1000)}s — erro (próximo cartão)`,
            );
            return buildPaymentResult(
              page,
              'error',
              pageUrl,
              gateCapture,
              '3DS sem confirmação automática',
            );
          }
        } else if (threedsStopOnVbvEnabled()) {
          const continueWait = config.threedsContinueGateWait !== false;
          if (!continueWait || stopNow) {
            const pageUrl = page.url();
            if (isCheckoutSuccessUrl(pageUrl)) {
              return buildPaymentResult(page, 'success', pageUrl, gateCapture, 'Pagamento confirmado');
            }
            const errNow = await takeCheckoutErrorResult(page, gateCapture);
            if (errNow) return errNow;
            return overrideThreedsIfCheckoutError(
              await build3dsRequiredResult(page, session, gateCapture, threeDs, elapsed, { browserOpen: stopNow }),
              { url: pageUrl },
            );
          }
          const extraMs = config.threedsExtraWaitMs ?? 12000;
          if (session?.threeDsSeenAt && Date.now() - session.threeDsSeenAt > extraMs) {
            const pageUrl = page.url();
            if (isCheckoutSuccessUrl(pageUrl)) {
              return buildPaymentResult(page, 'success', pageUrl, gateCapture, 'Pagamento confirmado');
            }
            const errNow = await takeCheckoutErrorResult(page, gateCapture);
            if (errNow) return errNow;
            return overrideThreedsIfCheckoutError(
              await build3dsRequiredResult(page, session, gateCapture, threeDs, elapsed),
              { url: pageUrl },
            );
          }
        }
      }
    }

    const visible = await scanPageForPaymentOutcome(page);
    if (takeConfirmed()) {
      return buildPaymentResult(page, 'success', page.url(), {
        ...gateCapture,
        best: () => takeConfirmed(),
      });
    }
    if (visible?.status === 'success' || isCheckoutSuccessUrl(page.url())) {
      return buildPaymentResult(page, 'success', page.url(), gateCapture, 'Pagamento confirmado');
    }
    if (visible?.status === 'error' && !/pagamento-sucesso|confirmacao-beneficio/i.test(url)) {
      return buildPaymentResult(page, 'error', url, gateCapture, checkoutErrorHint(visible.hint));
    }

    if (typeof gateCapture?.waitSignal === 'function') {
      await gateCapture.waitSignal(pollMs);
    } else {
      await sleep(pollMs);
    }
  }

  const elapsed = Date.now() - start;
  try {
    const finalUrl = page.url();
    if (isCheckoutSuccessUrl(finalUrl)) {
      return buildPaymentResult(page, 'success', finalUrl, gateCapture, 'Pagamento confirmado');
    }
  } catch {
    // page fechada
  }
  const timeoutError = await takeCheckoutErrorResult(page, gateCapture);
  if (timeoutError) return timeoutError;
  if (session?.threeDsSeen && threedsStopOnVbvEnabled()) {
    return overrideThreedsIfCheckoutError(
      await build3dsRequiredResult(page, session, gateCapture, session.threeDsSeen, elapsed),
      { url: page.url() },
    );
  }

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

/** POST /payments (não SSE) com id do pagamento. */
export const findPaymentPostCapture = (gateCapture) => {
  const list = gateCapture?.captures ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const c = list[i];
    const u = c.url || '';
    if (!/api-bsc\/api\/v1\/payments/i.test(u) || /\/sse/i.test(u)) continue;
    if (c.httpStatus >= 200 && c.httpStatus < 300 && c.body?.id) return c;
  }
  return null;
};

/** Aguarda id do pagamento (ou CONFIRMED) nas capturas do browser. */
export async function waitForPaymentIdFromGate(gateCapture, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  const poll = config.checkoutLinkGatePollMs ?? 80;
  while (Date.now() < deadline) {
    const confirmed = findConfirmedPaymentCapture(gateCapture);
    if (confirmed) {
      const id = confirmed.body?.id ?? confirmed.body?.payments?.[0]?.id ?? null;
      return { paymentId: id, alreadyConfirmed: true, capture: confirmed };
    }
    const post = findPaymentPostCapture(gateCapture);
    if (post?.body?.id) {
      return { paymentId: post.body.id, alreadyConfirmed: false, capture: post };
    }
    await sleep(poll);
  }
  return null;
};

export function buildPaymentResultFromHttpSse(sse, url, paymentId, opts = {}) {
  const st = String(sse?.status ?? '').toUpperCase();
  const base = { url, paymentId, httpGate: true, sseBody: sse };
  if (st === 'CONFIRMED') {
    return {
      ...base,
      status: 'success',
      gateCode: 'CONFIRMED',
      gateMessage: 'Pagamento confirmado',
      message: 'Pagamento confirmado',
      pagamentoErro: false,
    };
  }
  if (st === 'DENIED') {
    const msg = sse?.negativeReason || sse?.message || 'Pagamento negado';
    return {
      ...base,
      status: 'error',
      gateCode: 'DENIED',
      gateMessage: msg,
      message: msg,
      pagamentoErro: true,
    };
  }
  if (isCheckoutErrorUrl(url)) {
    const hint = checkoutErrorHint(sse?.message || sse?.negativeReason, 'Não foi possível concluir o pagamento');
    return {
      ...base,
      status: 'error',
      gateCode: st || 'ERROR',
      gateMessage: hint,
      message: hint,
      pagamentoErro: true,
    };
  }
  if (opts.had3ds && (!st || st === 'PENDING' || st === 'PROCESSING' || st === 'TIMEOUT')) {
    const pageUrl = opts.pageUrl || url;
    if (isCheckoutErrorUrl(pageUrl)) {
      const hint = checkoutErrorHint(opts.pageText || sse?.message, 'Não foi possível concluir o pagamento');
      return {
        ...base,
        url: pageUrl,
        status: 'error',
        gateCode: 'ERROR',
        gateMessage: hint,
        message: hint,
        pagamentoErro: true,
      };
    }
    if (!threedsStopOnVbvEnabled()) {
      const msg = sse?.message || 'Timeout aguardando gate após 3DS';
      return {
        ...base,
        status: 'timeout',
        gateCode: st || 'TIMEOUT',
        gateMessage: msg,
        message: msg,
        pagamentoErro: true,
      };
    }
    return {
      ...base,
      status: '3ds_required',
      gateCode: '3DS',
      gateMessage: 'Validação 3DS — aprovar no banco (browser já fechado)',
      message: 'Validação 3DS — aprovar no banco (browser já fechado)',
      pagamentoErro: false,
    };
  }
  const msg = sse?.message || 'Timeout aguardando SSE HTTP';
  return {
    ...base,
    status: st === 'TIMEOUT' || !st ? 'timeout' : 'error',
    gateCode: st || 'TIMEOUT',
    gateMessage: msg,
    message: msg,
    pagamentoErro: true,
  };
}

/** Fecha browser cedo: captura payment id → SSE HTTP. */
export async function waitForPaymentResultViaHttp(gateCapture, bemobiToken, checkoutUrl, opts = {}) {
  const idResult =
    opts.idResult ??
    (await waitForPaymentIdFromGate(
      gateCapture,
      opts.paymentIdWaitMs ?? config.checkoutLinkPaymentIdWaitMs ?? 12000,
    ));
  const sseTimeoutMs = opts.timeoutMs ?? 120000;
  const had3ds = Boolean(get3dsChallengeApiCapture(gateCapture));

  if (idResult?.alreadyConfirmed) {
    return buildPaymentResult(null, 'success', checkoutUrl, gateCapture);
  }

  if (!idResult?.paymentId) {
    if (had3ds && threedsStopOnVbvEnabled()) {
      return buildPaymentResultFromHttpSse(
        { status: 'PENDING' },
        checkoutUrl,
        null,
        { had3ds: true },
      );
    }
    return buildPaymentResult(
      null,
      'error',
      checkoutUrl,
      gateCapture,
      'POST /payments não capturado antes de fechar o browser',
    );
  }

  if (!bemobiToken) {
    return buildPaymentResult(null, 'error', checkoutUrl, gateCapture, 'bemobiToken ausente para SSE HTTP');
  }

  if (had3ds && config.threedsContinueGateWait) {
    const frictionlessMs = config.threedsExtraWaitMs ?? 12000;
    console.log(
      `[automation][3ds] frictionless HTTP SSE — aguardando CONFIRMED até ${Math.round(frictionlessMs / 1000)}s…`,
    );
    const sse = await waitHttpPaymentSse(bemobiToken, idResult.paymentId, frictionlessMs);
    if (String(sse?.status ?? '').toUpperCase() === 'CONFIRMED') {
      return buildPaymentResultFromHttpSse(sse, checkoutUrl, idResult.paymentId);
    }
    return buildPaymentResultFromHttpSse(sse, checkoutUrl, idResult.paymentId, { had3ds: true });
  }

  if (had3ds && !threedsStopOnVbvEnabled()) {
    console.log('[automation][3ds] challenge API — segue SSE HTTP (sem parar no VBV)');
  } else if (had3ds) {
    console.log('[automation][3ds] challenge API — sem frictionless, retorna 3DS');
    return buildPaymentResultFromHttpSse(
      { status: 'PENDING' },
      checkoutUrl,
      idResult.paymentId,
      { had3ds: true },
    );
  }

  console.log(
    `[automation] gate-wait HTTP SSE paymentId=${idResult.paymentId} 3ds_api=${had3ds}`,
  );
  const sse = await waitHttpPaymentSse(bemobiToken, idResult.paymentId, sseTimeoutMs);
  return buildPaymentResultFromHttpSse(sse, checkoutUrl, idResult.paymentId, {
    had3ds,
    gateCapture,
  });
};
