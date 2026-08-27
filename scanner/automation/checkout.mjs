import { config } from './config.mjs';
import {
  sleep,
  clickByText,
  dismissCookieBanner,
  dismissBonusModalIfVisible,
  randomName,
  setSessionStep,
  clickInAnyFrame,
} from './helpers.mjs';

const CARD_PAN_SELECTORS = ['#pan', 'input[name="pan"]', 'input[data-cy="pan"]', 'input[autocomplete="cc-number"]'];
const CARD_EXP_SELECTORS = ['#expiration', 'input[name="expirationDate"]', 'input[autocomplete="cc-exp"]'];
const CARD_CVV_SELECTORS = ['#cvv', 'input[name="cvv"]', 'input[autocomplete="cc-csc"]'];
const CARD_HOLDER_SELECTORS = ['#holder', 'input[name="holder"]', 'input[autocomplete="cc-name"]'];

export const isEldoradoCheckoutUrl = (url) => /eldorado\.m4u\.com\.br\/bsc\/checkout/i.test(url || '');

export const findCardPaymentFrame = (page) =>
  page.frames().find((f) => f.url().includes('new-claro-recarga.html') || isEldoradoCheckoutUrl(f.url())) ??
  null;

const isCheckoutFrameUrl = (url) =>
  isEldoradoCheckoutUrl(url) ||
  /smart-checkout|bemobi\.com|new-claro-recarga\.html/i.test(url || '');

export const hasSmartCheckout = async (page) => {
  const pageUrl = page.url() || '';
  if (/\/smartcheckout/i.test(pageUrl)) return true;
  const iframeSel =
    'iframe#checkout, iframe[title="smartCheckout"], iframe[src*="eldorado"], iframe[src*="bemobi"], iframe[src*="smart-checkout"]';
  if ((await page.locator(iframeSel).count()) > 0) return true;
  if (page.frames().some((f) => isCheckoutFrameUrl(f.url()))) return true;
  if ((await page.locator('#pan, input[name="pan"], input[autocomplete="cc-number"]').count()) > 0) {
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
    if ((await loc.count()) > 0) return loc;
  }
  throw new Error(`Campo não encontrado: ${selectors.join(', ')}`);
};

export const isPanFormReady = async (page) => {
  const frame = findCardPaymentFrame(page);
  const ctx = frame || page;
  const pan = ctx.locator('#pan').first();
  if ((await pan.count()) === 0) return false;
  try {
    await pan.waitFor({ state: 'visible', timeout: 1200 });
    return !(await pan.isDisabled());
  } catch {
    return false;
  }
};

export const waitForEldoradoCheckoutReady = async (page, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!isEldoradoCheckoutUrl(frame.url())) continue;
      const pan = frame.locator('#pan, input[name="pan"], input[autocomplete="cc-number"]').first();
      if ((await pan.count()) > 0) {
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
  if ((await iframe.count()) > 0) {
    await iframe.scrollIntoViewIfNeeded().catch(() => {});
  }
  await dismissBonusModalIfVisible(page).catch(() => {});
  await sleep(config.pollIntervalMs);
};

export const fillCardFormDirectly = async (page, pam) => {
  const frame = findCardPaymentFrame(page);
  const ctx = frame || page;
  const panInput = await resolveLocator(ctx, CARD_PAN_SELECTORS);
  const expirationInput = await resolveLocator(ctx, CARD_EXP_SELECTORS);
  const cvvInput = await resolveLocator(ctx, CARD_CVV_SELECTORS);
  const holderInput = await resolveLocator(ctx, CARD_HOLDER_SELECTORS);

  await panInput.fill(String(pam.pan).replace(/\D/g, ''), { force: true });
  await expirationInput.fill(String(pam.mmYY), { force: true });
  await cvvInput.fill(String(pam.cvv || config.defaultCvv), { force: true });
  await holderInput.fill(String(randomName(config.defaultCardholderMaxLen)), { force: true });
  await holderInput.press('Tab').catch(() => {});
  await sleep(config.cardFormSettleMs);
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

export const clickEldoradoPayButton = async (page, timeoutMs = 12000) => {
  const deadline = Date.now() + timeoutMs;
  await waitForPayButtonReady(page, Math.min(5000, timeoutMs));

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

const clickCheckoutNewCard = async (page) => {
  for (const frame of page.frames()) {
    if (!isEldoradoCheckoutUrl(frame.url())) continue;
    try {
      const hit = await frame.evaluate(() => {
        for (const el of document.querySelectorAll('*')) {
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (!/^novo\s+cr[eé]dito$/i.test(t) && !/^novo\s+cart[aã]o$/i.test(t)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 20) continue;
          el.click();
          return true;
        }
        return false;
      });
      if (hit) return true;
    } catch {
      // ignore
    }
  }
  return clickInAnyFrame(page, ['Novo crédito', 'Novo cartão', 'Cadastrar novo cartão'], 5000);
};

export const ensureCheckoutNewCardForm = async (page, session) => {
  if (await isPanFormReady(page)) return true;
  setSessionStep(session, 'checkout_novo_cartao', 'Selecionando novo cartão no checkout…');
  await prepareEldoradoCheckoutForm(page);
  for (let i = 0; i < 4; i += 1) {
    if (await isPanFormReady(page)) return true;
    await clickCheckoutNewCard(page);
    await sleep(Math.min(config.cardFormSettleMs || 450, 500));
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

export const fillWebLinkCardDirect = async (session, pam) => {
  const { page } = session;
  setSessionStep(session, 'fill_pan', 'Aguardando checkout Eldorado…');
  await dismissCookieBanner(page);
  if (!(await ensureSmartCheckoutReady(page, session))) {
    throw new Error('Checkout Eldorado não carregou a tempo.');
  }
  await prepareEldoradoCheckoutForm(page);
  await ensureCheckoutNewCardForm(page, session);
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
  let payOk = await clickEldoradoPayButton(page, 12000);
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
