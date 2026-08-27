import { config } from './config.mjs';
import {
  sleep,
  clickByText,
  dismissCookieBanner,
  dismissBonusModalIfVisible,
  setSessionStep,
  webPortalPath,
  visibleTextMatch,
} from './helpers.mjs';
import {
  hasSmartCheckout,
  waitForSmartCheckout,
  detectPixOnlyCheckout,
  runWebLinkCheckoutPay,
} from './checkout.mjs';
import { waitForPaymentResult } from './gate.mjs';

const webNeedsOutroNumero = (session) => {
  const access = String(session?.accessNumber || '').replace(/\D/g, '');
  const target = String(session?.rechargeTargetNumber || access).replace(/\D/g, '');
  return Boolean(access && target && target !== access);
};

export const ensureWebRechargeReady = async (session) => {
  const { page } = session;
  await dismissCookieBanner(page);
  if (webNeedsOutroNumero(session)) return;
  if (await visibleTextMatch(page, /Escolha um valor de recarga/i)) return;

  const hasValueBtn = await page
    .evaluate(() => {
      for (const el of document.querySelectorAll('button, [role="button"], a')) {
        const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (/R\$\s*\d{1,4}/.test(t) && t.length < 40) return true;
      }
      return false;
    })
    .catch(() => false);
  if (hasValueBtn) return;

  if (await clickByText(page, ['Fazer recarga', 'Fazer Recarga', 'Recarregar'], 15000)) {
    await sleep(config.pauseAfterClickMs);
    return;
  }

  const url = page.url() || '';
  if (!/\/numero|\/home/i.test(url)) {
    setSessionStep(session, 'web_numero', 'Abrindo tela de recarga…');
    await page.goto(webPortalPath('numero'), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await dismissCookieBanner(page);
    await sleep(config.pauseAfterClickMs);
  }
};

export const clickRechargeValueButton = async (page, session, rechargeValue) => {
  setSessionStep(session, 'valor', `Selecionando valor R$ ${rechargeValue}…`);
  await dismissCookieBanner(page);
  const valRe = new RegExp(`R\\$\\s*${rechargeValue}\\b`);
  const candidates = [
    page.getByRole('button', { name: valRe }).first(),
    page.getByRole('radio', { name: valRe }).first(),
    page.locator("button, [role='button'], [role='radio'], label, a").filter({ hasText: valRe }).first(),
    page.getByText(valRe).first(),
  ];
  for (const loc of candidates) {
    try {
      if ((await loc.count()) === 0) continue;
      await loc.waitFor({ state: 'visible', timeout: 5000 });
      await loc.click({ timeout: config.actionTimeoutMs, force: true });
      await dismissBonusModalIfVisible(page);
      return;
    } catch {
      // próximo
    }
  }
  const clicked = await page.evaluate((valor) => {
    const re = new RegExp(`R\\$\\s*${valor}\\b`);
    const nodes = [...document.querySelectorAll('button, [role="button"], [role="radio"], label, a, div, span')];
    const el = nodes.find((n) => {
      const t = (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
      return t.length < 80 && re.test(t);
    });
    if (!el) return false;
    el.click();
    return true;
  }, rechargeValue);
  if (clicked) {
    await dismissBonusModalIfVisible(page);
    return;
  }
  throw new Error(`Valor R$ ${rechargeValue} não disponível na Claro.`);
};

/** Espera iframe Eldorado após escolher valor (modal bônus atrapalha). */
async function waitForCheckoutAfterValue(page, session) {
  setSessionStep(session, 'smart_checkout', 'Aguardando checkout abrir…');
  const started = Date.now();
  const deadline = started + config.checkoutOpenTimeoutMs;
  let lastLog = 0;

  while (Date.now() < deadline) {
    await dismissBonusModalIfVisible(page).catch(() => {});
    if (await hasSmartCheckout(page)) return true;
    if (await detectPixOnlyCheckout(page)) {
      throw new Error('Valor não disponível nesse número (somente Pix).');
    }
    const elapsed = Date.now() - started;
    if (elapsed - lastLog > 8000) {
      console.log(
        `[automation] aguardando checkout… ${Math.round(elapsed / 1000)}s url=${(page.url() || '').slice(0, 80)}`,
      );
      lastLog = elapsed;
    }
    await sleep(config.pollIntervalMs);
  }

  await dismissBonusModalIfVisible(page).catch(() => {});
  if (await hasSmartCheckout(page)) return true;
  if (await waitForSmartCheckout(page, 15000)) return true;

  if (await detectPixOnlyCheckout(page)) {
    throw new Error('Valor não disponível nesse número (cartão indisponível).');
  }
  return false;
}

export const runWebLinkRecharge = async (session, payload) => {
  const { page } = session;
  const rechargeValue = String(payload.rechargeValue ?? '').replace(/\D/g, '');
  if (!rechargeValue) throw new Error('rechargeValue é obrigatório.');

  await ensureWebRechargeReady(session);
  await dismissBonusModalIfVisible(page);

  await clickRechargeValueButton(page, session, rechargeValue);
  await dismissBonusModalIfVisible(page).catch(() => {});
  await sleep(config.pauseAfterValueMs);

  const checkoutOk = await waitForCheckoutAfterValue(page, session);
  if (!checkoutOk) {
    const { saveStallDebug } = await import('./debug.mjs');
    await saveStallDebug(page, session, session.gateCapture, 'checkout_nao_abriu', {
      rechargeValue,
      url: page.url(),
    }).catch(() => {});
    throw new Error('Checkout não abriu após selecionar valor.');
  }

  const pam = payload._pamParsed;
  await runWebLinkCheckoutPay(session, pam);
  setSessionStep(session, 'aguardando_gate', 'Aguardando retorno da gate…');
  console.log(
    `[automation] gate-wait iniciado msisdn=${session.accessNumber} valor=R$${rechargeValue} url=${page.url()}`,
  );
  const paymentResult = await waitForPaymentResult(page, 120000, session.gateCapture, session);
  if (paymentResult?.status === 'success') {
    setSessionStep(session, 'sucesso', 'Pagamento confirmado com sucesso');
  } else if (paymentResult?.status === '3ds_required') {
    setSessionStep(session, '3ds_required', paymentResult.gateMessage || '3DS — confirme no Edge');
  } else if (paymentResult?.status === 'error') {
    setSessionStep(session, 'erro_gate', paymentResult.gateMessage || 'Pagamento recusado');
    const { saveStallDebug } = await import('./debug.mjs');
    await saveStallDebug(page, session, session.gateCapture, 'gate_error', {
      gateMessage: paymentResult.gateMessage,
      gateCode: paymentResult.gateCode,
    }).catch(() => {});
  } else {
    const dbg = paymentResult?.debug;
    const hint = dbg?.jsonPath ? ` (debug: ${dbg.jsonPath})` : paymentResult?.debug?.jsonPath ? ` (debug: ${paymentResult.debug.jsonPath})` : '';
    setSessionStep(session, 'timeout', `${paymentResult?.message || 'Timeout no pagamento'}${hint}`);
  }
  return paymentResult;
};
