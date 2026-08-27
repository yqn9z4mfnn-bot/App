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

export const hasSmartCheckout = async (page) => {
  if ((await page.locator('iframe#checkout, iframe[title="smartCheckout"]').count()) > 0) return true;
  return page.frames().some((f) => isEldoradoCheckoutUrl(f.url()));
};

export const waitForSmartCheckout = async (page, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasSmartCheckout(page)) return true;
    await sleep(350);
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
    await sleep(350);
  }
  return null;
};

export const prepareEldoradoCheckoutForm = async (page) => {
  const iframe = page.locator('iframe#checkout, iframe[title="smartCheckout"]').first();
  if ((await iframe.count()) > 0) {
    await iframe.scrollIntoViewIfNeeded().catch(() => {});
  }
  await dismissBonusModalIfVisible(page).catch(() => {});
  await sleep(400);
};

export const fillCardFormDirectly = async (page, pam) => {
  const frame = findCardPaymentFrame(page);
  const ctx = frame || page;
  const panInput = await resolveLocator(ctx, CARD_PAN_SELECTORS);
  const expirationInput = await resolveLocator(ctx, CARD_EXP_SELECTORS);
  const cvvInput = await resolveLocator(ctx, CARD_CVV_SELECTORS);
  const holderInput = await resolveLocator(ctx, CARD_HOLDER_SELECTORS);

  await panInput.fill(String(pam.pan).replace(/\D/g, ''), { force: true });
  await expirationInput.fill('', { force: true });
  await expirationInput.type(String(pam.mmYY), { delay: config.pamTypingDelayMs, force: true });
  await cvvInput.fill(String(pam.cvv || config.defaultCvv), { force: true });
  await holderInput.fill('', { force: true });
  await holderInput.type(String(randomName(config.defaultCardholderMaxLen)), {
    delay: config.pamTypingDelayMs,
    force: true,
  });
};

export const fillEldoradoBscCheckout = async (page, pam) => {
  const frame = (await waitForEldoradoCheckoutReady(page, 45000)) || findCardPaymentFrame(page);
  if (!frame) throw new Error('Iframe Eldorado checkout não encontrado');
  await fillCardFormDirectly(page, pam);
};

export const clickEldoradoPayButton = async (page, timeoutMs = 30000) =>
  clickInAnyFrame(
    page,
    ['Pagar R$', 'Pagar', 'Pagar agora', 'Confirmar pagamento', 'Confirmar', 'Finalizar', 'Recarregar'],
    timeoutMs,
  );

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
  for (let i = 0; i < 6; i += 1) {
    if (await isPanFormReady(page)) return true;
    await clickCheckoutNewCard(page);
    await sleep(config.cardFormSettleMs || 1200);
  }
  return isPanFormReady(page);
};

export const ensureSmartCheckoutReady = async (page, session) => {
  await dismissCookieBanner(page);
  await dismissBonusModalIfVisible(page);
  if (await hasSmartCheckout(page)) {
    await prepareEldoradoCheckoutForm(page);
    await waitForEldoradoCheckoutReady(page, 30000);
    return true;
  }
  setSessionStep(session, 'smart_checkout', 'Aguardando checkout abrir…');
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await dismissBonusModalIfVisible(page);
    if (await hasSmartCheckout(page)) {
      await prepareEldoradoCheckoutForm(page);
      await waitForEldoradoCheckoutReady(page, 25000);
      return true;
    }
    await sleep(400);
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
  const frame = await waitForEldoradoCheckoutReady(page, 15000);
  if (frame) {
    await fillEldoradoBscCheckout(page, pam);
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
    payOk = await clickInAnyFrame(
      page,
      ['Continuar', 'Finalizar pagamento', 'Recarregar'],
      30000,
    );
  }
  if (!payOk) throw new Error('Botão de confirmar pagamento no checkout não encontrado.');
};
