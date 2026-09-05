import { config } from './config.mjs';
import {
  sleep,
  clickByText,
  dismissCookieBanner,
  dismissBonusModalIfVisible,
  randomName,
  setSessionStep,
  clickInAnyFrame,
  isDetachedFrameError,
  safeLocatorCount,
} from './helpers.mjs';
import {
  waitForCheckoutAntifraud,
  fillCardFieldsHuman,
  simulatePrePayInteraction,
} from './antifraud-browser.mjs';

const CARD_PAN_SELECTORS = ['#pan', 'input[name="pan"]', 'input[data-cy="pan"]', 'input[autocomplete="cc-number"]'];
const CARD_EXP_SELECTORS = ['#expiration', 'input[name="expirationDate"]', 'input[autocomplete="cc-exp"]'];
const CARD_CVV_SELECTORS = ['#cvv', 'input[name="cvv"]', 'input[autocomplete="cc-csc"]'];
const CARD_HOLDER_SELECTORS = ['#holder', 'input[name="holder"]', 'input[autocomplete="cc-name"]'];

export const isEldoradoCheckoutUrl = (url) => /eldorado\.m4u\.com\.br\/bsc\/checkout/i.test(url || '');

export const findCardPaymentFrame = (page) =>
  page.frames().find((f) => f.url().includes('new-claro-recarga.html') || isEldoradoCheckoutUrl(f.url())) ??
  null;

/** Procura iframe (ou página) que contém o campo PAN. */
export const findPanContext = async (page) => {
  const preferred = findCardPaymentFrame(page);
  if (preferred) {
    for (const sel of CARD_PAN_SELECTORS) {
      const pan = preferred.locator(sel).first();
      if ((await safeLocatorCount(pan)) > 0) return preferred;
    }
  }
  for (const frame of page.frames()) {
    for (const sel of CARD_PAN_SELECTORS) {
      const pan = frame.locator(sel).first();
      if ((await safeLocatorCount(pan)) > 0) return frame;
    }
  }
  return page;
};

const isCheckoutFrameUrl = (url) =>
  isEldoradoCheckoutUrl(url) ||
  /smart-checkout|bemobi\.com|new-claro-recarga\.html/i.test(url || '');

export const hasSmartCheckout = async (page) => {
  const pageUrl = page.url() || '';
  if (/\/smartcheckout/i.test(pageUrl)) return true;
  const iframeSel =
    'iframe#checkout, iframe[title="smartCheckout"], iframe[src*="eldorado"], iframe[src*="bemobi"], iframe[src*="smart-checkout"]';
  if ((await safeLocatorCount(page.locator(iframeSel))) > 0) return true;
  if (page.frames().some((f) => isCheckoutFrameUrl(f.url()))) return true;
  if ((await safeLocatorCount(page.locator('#pan, input[name="pan"], input[autocomplete="cc-number"]'))) > 0) {
    return true;
  }
  return false;
};

export const waitForSmartCheckout = async (page, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasSmartCheckout(page)) return true;
    await sleep(config.pollIntervalMs);
  }
  return false;
};

const resolveLocator = async (ctx, selectors) => {
  for (const sel of selectors) {
    const loc = ctx.locator(sel).first();
    if ((await safeLocatorCount(loc)) > 0) return loc;
  }
  throw new Error(`Campo não encontrado: ${selectors.join(', ')}`);
};

export const isPanFormReady = async (page) => {
  for (const ctx of [page, ...page.frames()]) {
    for (const sel of CARD_PAN_SELECTORS) {
      const pan = ctx.locator(sel).first();
      if ((await safeLocatorCount(pan)) === 0) continue;
      try {
        await pan.waitFor({ state: 'attached', timeout: 800 });
        if (await pan.isDisabled()) continue;
        if (await pan.isVisible().catch(() => false)) return true;
        // Eldorado BSC: inputs existem no DOM mas podem falhar isVisible() até expandir o bloco.
        const box = await pan.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) return true;
        return true;
      } catch {
        // try next selector
      }
    }
  }
  return false;
};

const clickCreditPaymentMethod = async (page) => {
  for (const frame of page.frames()) {
    const hit = await frame
      .evaluate(() => {
        const skip = /pix|apple\s*pay|nupay|click\s*to\s*pay|google\s*pay/i;
        const want = /cart[aã]o/i;
        const credit = /cr[eé]dito/i;
        const hits = [];
        for (const el of document.querySelectorAll(
          'button, [role="button"], a, li, [class*="method" i], [class*="option" i], div, label, span',
        )) {
          const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length > 48 || skip.test(t) || !want.test(t) || !credit.test(t)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 40 || r.height < 20) continue;
          hits.push({ el, t, area: r.width * r.height, y: r.top });
        }
        hits.sort((a, b) => a.y - b.y || b.area - a.area);
        const pick = hits[0];
        if (!pick) return null;
        pick.el.click();
        return pick.t;
      })
      .catch(() => null);
    if (hit) {
      console.log(`[automation] clicou método: "${hit}"`);
      return hit;
    }
  }
  return null;
};

const checkoutHasUi = async (page) => {
  if (await isPanFormReady(page)) return 'pan';
  for (const frame of page.frames()) {
    const kind = await frame
      .evaluate(() => {
        const t = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t) return null;
        if (/n[uú]mero do cart[aã]o/i.test(t)) return 'pan-label';
        if (/escolha como pagar/i.test(t)) return 'methods';
        if (/cart[aã]o/i.test(t) && /cr[eé]dito/i.test(t) && /total a pagar/i.test(t)) return 'methods';
        if (/total a pagar/i.test(t) && t.length > 20) return 'shell';
        return null;
      })
      .catch(() => null);
    if (kind) return kind;
  }
  return null;
};

const waitForCheckoutShell = async (page, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const kind = await checkoutHasUi(page);
    if (kind) return kind;
    await sleep(Math.max(config.pollIntervalMs || 180, 120));
  }
  return checkoutHasUi(page);
};

const ensureCreditCardSectionOpen = async (page) => {
  if (await isPanFormReady(page)) return true;
  const hit = await clickCreditPaymentMethod(page);
  if (hit) {
    await sleep(config.cardFormSettleMs || 450);
    if (await isPanFormReady(page)) return true;
  }
  const labels = ['Cartão (Crédito)', 'Cartão Crédito', 'Cartão de crédito', 'Cartão'];
  for (const label of labels) {
    const clicked = await page
      .evaluate((text) => {
        for (const el of document.querySelectorAll('button, [role="button"], div, label, span, li')) {
          const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (t !== text && !new RegExp(`^${text}$`, 'i').test(t)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 24 || r.height < 16) continue;
          el.click();
          return t;
        }
        return null;
      }, label)
      .catch(() => null);
    if (clicked) {
      await sleep(config.cardFormSettleMs || 450);
      if (await isPanFormReady(page)) return true;
    }
  }
  return isPanFormReady(page);
};

const isCvvOnlyFormReady = async (page) => {
  if (await isPanFormReady(page)) return false;
  for (const ctx of [page, ...page.frames()]) {
    for (const sel of CARD_CVV_SELECTORS) {
      const cvv = ctx.locator(sel).first();
      if ((await safeLocatorCount(cvv)) === 0) continue;
      try {
        await cvv.waitFor({ state: 'visible', timeout: 800 });
        if (!(await cvv.isDisabled())) return true;
      } catch {
        // continue
      }
    }
  }
  return false;
};

export const waitForEldoradoCheckoutReady = async (page, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!isEldoradoCheckoutUrl(frame.url())) continue;
      const pan = frame.locator('input[name="pan"], #pan, input[autocomplete="cc-number"]').first();
      if ((await safeLocatorCount(pan)) > 0) {
        try {
          await pan.waitFor({ state: 'attached', timeout: 2000 });
          return frame;
        } catch {
          // continue
        }
      }
    }
    await sleep(config.pollIntervalMs);
  }
  return null;
};

export const prepareEldoradoCheckoutForm = async (page) => {
  const iframe = page.locator('iframe#checkout, iframe[title="smartCheckout"]').first();
  if ((await safeLocatorCount(iframe)) > 0) {
    await iframe.scrollIntoViewIfNeeded().catch(() => {});
  }
  await dismissBonusModalIfVisible(page).catch(() => {});
  await sleep(config.pollIntervalMs);
};

export const fillCardFormDirectly = async (page, pam, opts = {}) => {
  const maxAttempts = opts.frameRetries ?? 3;
  let lastErr = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const ctx = await findPanContext(page);
      const panInput = await resolveLocator(ctx, CARD_PAN_SELECTORS);
      const expirationInput = await resolveLocator(ctx, CARD_EXP_SELECTORS);
      const cvvInput = await resolveLocator(ctx, CARD_CVV_SELECTORS);
      const holderInput = await resolveLocator(ctx, CARD_HOLDER_SELECTORS);
      const holderName = String(randomName(config.defaultCardholderMaxLen));

      const useHuman = opts.human && config.antifraudHumanFill;
      if (useHuman) {
        await page.evaluate(() => {
          const pan = document.querySelector('input[name="pan"]');
          pan?.scrollIntoView({ block: 'center', behavior: 'instant' });
          const card = pan?.closest('section, [class*="payment" i], [class*="accordion" i], div');
          card?.scrollIntoView?.({ block: 'center', behavior: 'instant' });
        }).catch(() => {});
        await sleep(150);
        await fillCardFieldsHuman(
          { pan: panInput, expiration: expirationInput, cvv: cvvInput, holder: holderInput },
          pam,
          holderName,
        );
      } else {
        await panInput.fill(String(pam.pan).replace(/\D/g, ''), { force: true });
        await expirationInput.fill(`${pam.mm}${pam.yy}`, { force: true });
        await cvvInput.fill(String(pam.cvv || config.defaultCvv), { force: true });
        await holderInput.fill(holderName, { force: true });
        await holderInput.press('Tab').catch(() => {});
      }

      const settleMs = useHuman
        ? config.antifraudSettleMs ?? 280
        : opts.fast
          ? config.checkoutLinkCardSettleMs ?? 60
          : config.cardFormSettleMs;
      if (settleMs > 0) await sleep(settleMs);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1 && isDetachedFrameError(err)) {
        await sleep(config.pollIntervalMs || 100);
        continue;
      }
      throw err;
    }
  }

  throw lastErr || new Error('Falha ao preencher formulário do cartão.');
};

export const fillEldoradoBscCheckout = async (page, pam, frame = null) => {
  const checkoutFrame =
    frame || findCardPaymentFrame(page) || (await waitForEldoradoCheckoutReady(page, 8000));
  if (!checkoutFrame) throw new Error('Iframe Eldorado checkout não encontrado');
  await fillCardFormDirectly(page, pam);
};

const PAY_BUTTON_LABELS = [
  'Pagar R$',
  'Pagar',
  'Pagar agora',
  'Confirmar pagamento',
  'Confirmar',
  'Finalizar pagamento',
  'Finalizar',
  'Recarregar',
  'Continuar',
];

const clickPayButtonInFrame = async (frame) => {
  try {
    const clicked = await frame.evaluate(() => {
      const skip = /novo\s+(cr[eé]dito|cart[aã]o)|cadastrar|voltar|cancelar/i;
      const prefer = /pagar\s*r?\$?|confirmar\s*pagamento|finalizar\s*pagamento|recarregar\s*agora/i;
      const hits = [];
      for (const el of document.querySelectorAll(
        'button, [role="button"], input[type="submit"], a, div[class*="button" i]',
      )) {
        const t = (el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 60 || skip.test(t)) continue;
        if (!prefer.test(t) && !/^pagar$/i.test(t) && !/^confirmar$/i.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 48 || r.height < 28 || r.top < 0) continue;
        const disabled =
          el.disabled ||
          el.getAttribute('aria-disabled') === 'true' ||
          /disabled|inactive/i.test(String(el.className || ''));
        hits.push({ el, t, y: r.top, area: r.width * r.height, disabled });
      }
      hits.sort((a, b) => {
        if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
        const aPay = /pagar/i.test(a.t) ? 0 : 1;
        const bPay = /pagar/i.test(b.t) ? 0 : 1;
        if (aPay !== bPay) return aPay - bPay;
        return b.y - a.y || b.area - a.area;
      });
      const pick = hits.find((h) => !h.disabled) || hits[0];
      if (!pick) return null;
      pick.el.scrollIntoView({ block: 'center', behavior: 'instant' });
      pick.el.click();
      return pick.t;
    });
    return clicked || null;
  } catch {
    return null;
  }
};

const waitForPayButtonReady = async (page, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!isCheckoutFrameUrl(frame.url())) continue;
      const ready = await frame
        .evaluate(() => {
          const skip = /novo\s+(cr[eé]dito|cart[aã]o)|cadastrar|voltar|cancelar/i;
          for (const el of document.querySelectorAll('button, [role="button"], input[type="submit"]')) {
            const t = (el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
            if (!/pagar|confirmar|finalizar|recarregar/i.test(t) || skip.test(t)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 48 || r.height < 28) continue;
            const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
            if (!disabled) return t;
          }
          return null;
        })
        .catch(() => null);
      if (ready) return ready;
    }
    await sleep(config.pollIntervalMs);
  }
  return null;
};

export const clickEldoradoPayButton = async (page, timeoutMs = 12000, payReadyMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  await waitForPayButtonReady(page, Math.min(payReadyMs, timeoutMs));

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!isCheckoutFrameUrl(frame.url())) continue;
      const label = await clickPayButtonInFrame(frame);
      if (label) {
        console.log(`[automation] clicou pagar Eldorado: "${label}" frame=${frame.url().slice(0, 90)}`);
        return true;
      }
    }
    if (await clickInAnyFrame(page, PAY_BUTTON_LABELS, 1200)) return true;
    await sleep(Math.min(config.pollIntervalMs, 150));
  }
  return false;
};

const MANUAL_CARD_LABELS = [
  'Inserir dados do cartão manualmente',
  'Enter card details manually',
  'Usar outro cartão',
  'Pagar com outro cartão',
  'Outro cartão',
  'Cadastrar novo cartão',
  'Novo crédito',
  'Novo cartão',
  'Novo',
];

const CLICK_TO_PAY_SKIP_LABELS = [
  'Inserir dados do cartão manualmente',
  'Enter card details manually',
  'Continuar sem',
  'Pagar com cartão',
  'Cartão de crédito',
  'Cartão (Crédito)',
  'Novo cartão',
  'Outro cartão',
  'Usar outro cartão',
];

/** Evita fluxo Click-to-Pay (src.mastercard.com) que gera INVALID_STATE/BPG_000. */
export const bypassClickToPay = async (page) => {
  let hit = null;
  for (const frame of page.frames()) {
    try {
      hit = await frame.evaluate(() => {
        const skipUi = /click\s*to\s*pay|mastercard\s+pass/i;
        const manual = [
          /inserir dados do cart[aã]o manualmente/i,
          /enter card details manually/i,
          /continuar sem/i,
          /novo cart[aã]o/i,
          /outro cart[aã]o/i,
          /usar outro cart[aã]o/i,
          /cart[aã]o de cr[eé]dito/i,
        ];
        for (const el of document.querySelectorAll('button, a, [role="button"], label, span, div')) {
          const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length > 64) continue;
          if (skipUi.test(t) && manual.some((re) => re.test(t))) {
            const r = el.getBoundingClientRect();
            if (r.width < 20 || r.height < 16) continue;
            el.click();
            return t;
          }
        }
        for (const el of document.querySelectorAll('button, a, [role="button"], label, span, div')) {
          const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!manual.some((re) => re.test(t))) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 16) continue;
          el.click();
          return t;
        }
        return null;
      });
    } catch {
      // ignore cross-origin
    }
    if (hit) break;
  }
  if (!hit) {
    hit = await clickInAnyFrame(page, CLICK_TO_PAY_SKIP_LABELS, 1500).catch(() => null);
  }
  if (hit) {
    console.log(`[automation] bypass Click-to-Pay: "${String(hit).slice(0, 60)}"`);
    await sleep(config.cardFormSettleMs || 450);
  }
  return Boolean(hit);
};

/** Bloqueia Click-to-Pay SRC — checkout segue só pelo tokenizer Eldorado. */
export const installCheckoutLinkRouteGuards = async (context) => {
  if (String(process.env.CHECKOUT_BYPASS_SRC ?? '1').toLowerCase() === '0') return;
  await context.route((url) => {
    const u = url.toString();
    return /src\.mastercard\.com/i.test(u) && /\/payments/i.test(u);
  }, (route) => {
    console.log(
      `[automation] bloqueando SRC ${route.request().method()} ${route.request().url().slice(0, 100)}`,
    );
    route.abort('blockedbyclient');
  });
  console.log('[automation] route guard Click-to-Pay (SRC payments) ativo');
};

const dismissCheckoutOverlays = async (page) => {
  await dismissBonusModalIfVisible(page).catch(() => {});
  await clickInAnyFrame(page, MANUAL_CARD_LABELS, 600).catch(() => {});
};

const clickCheckoutNewCard = async (page) => {
  await dismissCheckoutOverlays(page);
  for (const frame of page.frames()) {
    try {
      const hit = await frame.evaluate(() => {
        const patterns = [
          /^novo(\s+cr[eé]dito|\s+cart[aã]o)?$/i,
          /^cadastrar novo cart[aã]o$/i,
          /^inserir dados do cart[aã]o manualmente$/i,
          /^usar outro cart[aã]o$/i,
          /^pagar com outro cart[aã]o$/i,
          /^outro cart[aã]o$/i,
        ];
        for (const el of document.querySelectorAll('button, a, [role="button"], span, div')) {
          const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!patterns.some((re) => re.test(t))) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 20) continue;
          el.click();
          return t;
        }
        return null;
      });
      if (hit) return true;
    } catch {
      // ignore
    }
  }
  return clickInAnyFrame(page, MANUAL_CARD_LABELS, 1200);
};

export const ensureCheckoutNewCardForm = async (page, session) => {
  setSessionStep(session, 'checkout_novo_cartao', 'Aguardando formulário do cartão…');
  await prepareEldoradoCheckoutForm(page);
  const deadline = Date.now() + (config.cardFormReadyTimeoutMs || 18000);
  while (Date.now() < deadline) {
    if (await isPanFormReady(page)) return true;
    const hasPanLabel = await page
      .evaluate(() => /n[uú]mero do cart[aã]o/i.test(document.body?.innerText || ''))
      .catch(() => false);
    if (hasPanLabel) {
      await sleep(config.cardFormSettleMs || 450);
      if (await isPanFormReady(page)) return true;
    }
    await clickCheckoutNewCard(page);
    await sleep(config.cardFormSettleMs || 450);
  }
  return isPanFormReady(page);
};

export const ensureSmartCheckoutReady = async (page, session) => {
  await dismissCookieBanner(page);
  await dismissBonusModalIfVisible(page);
  if (await hasSmartCheckout(page)) {
    await prepareEldoradoCheckoutForm(page);
    await waitForEldoradoCheckoutReady(page, 10000);
    return true;
  }
  setSessionStep(session, 'smart_checkout', 'Aguardando checkout abrir…');
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await dismissBonusModalIfVisible(page);
    if (await hasSmartCheckout(page)) {
      await prepareEldoradoCheckoutForm(page);
      await waitForEldoradoCheckoutReady(page, 8000);
      return true;
    }
    await sleep(config.pollIntervalMs);
  }
  return false;
};

export const detectPixOnlyCheckout = async (page) => {
  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return /pix/i.test(text) && !/cart[aã]o de cr[eé]dito/i.test(text);
};

export const ensureCheckoutLinkPanReady = async (page) => {
  const poll = Math.max(config.checkoutLinkPollMs ?? 50, 80);
  const timeoutMs = config.checkoutLinkPanTimeoutMs ?? 22000;
  const deadline = Date.now() + timeoutMs;
  const shell = await waitForCheckoutShell(page, Math.min(18000, Math.max(0, deadline - Date.now())));
  if (shell) console.log(`[automation] checkout UI: ${shell}`);
  await bypassClickToPay(page);
  if (shell && shell !== 'pan') {
    await ensureCreditCardSectionOpen(page);
  }
  while (Date.now() < deadline) {
    try {
      if (await isPanFormReady(page)) return true;
      if (await isCvvOnlyFormReady(page)) {
        await clickCheckoutNewCard(page);
      } else {
        await ensureCreditCardSectionOpen(page);
      }
    } catch (err) {
      if (!isDetachedFrameError(err)) throw err;
    }
    await sleep(poll);
  }
  try {
    return isPanFormReady(page);
  } catch (err) {
    if (isDetachedFrameError(err)) return false;
    throw err;
  }
};

export const fillWebLinkCardDirect = async (session, pam) => {
  const { page } = session;
  setSessionStep(session, 'fill_pan', 'Aguardando checkout Eldorado…');

  if (session.checkoutLinkMode) {
    if (!(await ensureCheckoutLinkPanReady(page))) {
      const { saveStallDebug } = await import('./debug.mjs');
      await saveStallDebug(page, session, session.gateCapture, 'pan_missing_checkout_link', {
        cvvOnly: await isCvvOnlyFormReady(page),
      }).catch(() => {});
      throw new Error('Formulário PAN não abriu — checkout pode estar em cartão salvo (CVV só).');
    }
    await bypassClickToPay(page);
    await clickCheckoutNewCard(page);
    await ensureCreditCardSectionOpen(page);
    setSessionStep(session, 'fill_pan', 'PAN / validade / CVV / nome…');
    await fillCardFormDirectly(page, pam, {
      fast: false,
      human: true,
    });
    session.pamTouchCommitted = true;
    return;
  }

  await dismissCookieBanner(page);
  if (!(await ensureSmartCheckoutReady(page, session))) {
    throw new Error('Checkout Eldorado não carregou a tempo.');
  }
  await prepareEldoradoCheckoutForm(page);
  const hasPan = await ensureCheckoutNewCardForm(page, session);
  if (!hasPan) {
    await sleep(2000);
    if (!(await isPanFormReady(page))) {
      throw new Error('Formulário PAN não abriu — checkout pode estar em cartão salvo (CVV só).');
    }
  }
  setSessionStep(session, 'fill_pan', 'PAN / validade / CVV / nome…');
  const frame = findCardPaymentFrame(page) || (await waitForEldoradoCheckoutReady(page, 6000));
  if (frame) {
    await fillEldoradoBscCheckout(page, pam, frame);
  } else {
    await fillCardFormDirectly(page, pam);
  }
  session.pamTouchCommitted = true;
};

export const runWebLinkCheckoutPay = async (session, pam) => {
  const { page } = session;
  await fillWebLinkCardDirect(session, pam);
  setSessionStep(session, 'pagar', 'Confirmando pagamento…');
  await simulatePrePayInteraction(page);
  const payTimeout = session.checkoutLinkMode && config.checkoutLinkFast ? 6000 : 12000;
  const payReadyMs = session.checkoutLinkMode && config.checkoutLinkFast ? 1500 : 5000;
  let payOk = await clickEldoradoPayButton(page, payTimeout, payReadyMs);
  if (!payOk) {
    payOk = await clickInAnyFrame(page, PAY_BUTTON_LABELS, 4000);
  }
  if (!payOk) {
    const { saveStallDebug } = await import('./debug.mjs');
    await saveStallDebug(page, session, session.gateCapture, 'pay_button_missing', {
      url: page.url(),
      frames: page.frames().map((f) => f.url()).slice(0, 12),
    }).catch(() => {});
    throw new Error('Botão de confirmar pagamento no checkout não encontrado.');
  }
};
