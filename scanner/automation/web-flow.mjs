import { config } from './config.mjs';
import {
  sleep,
  clickByText,
  dismissCookieBanner,
  dismissBonusModalIfVisible,
  dismissBlockingModals,
  confirmProceedAfterValue,
  selectCreditCardPaymentMethod,
  waitForPaymentMethodModal,
  isRechargeValueSelected,
  detectPaymentMethodModal,
  clickPrezaoRenewBanner,
  clickValueGridCard,
  hasPrezaoBanner,
  selectRechargeValue,
  selectOutroNumeroClaro,
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
import { waitForPaymentResult, hasSmartCheckoutApiCall } from './gate.mjs';

const webNeedsOutroNumero = (session) => {
  const access = String(session?.accessNumber || '').replace(/\D/g, '');
  const target = String(session?.rechargeTargetNumber || access).replace(/\D/g, '');
  return Boolean(access && target && target !== access);
};

export const ensureWebRechargeReady = async (session) => {
  const { page } = session;
  await dismissCookieBanner(page);
  if (webNeedsOutroNumero(session)) {
    await selectOutroNumeroClaro(page, session, session.rechargeTargetNumber);
    return;
  }
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

export const clickRechargeValueButton = async (page, session, rechargeValue, opts = {}) => {
  const { quiet = false, doubleTap = false } = opts;
  if (!quiet) setSessionStep(session, 'valor', `Selecionando valor R$ ${rechargeValue}…`);
  await dismissBlockingModals(page);
  const valRe = new RegExp(`R\\$\\s*${rechargeValue}(?:,00)?\\b`);
  const valueCard = page
    .locator("button, [role='button'], [role='radio'], label, a, div")
    .filter({ hasText: valRe })
    .filter({ hasNotText: /renove seu prez/i })
    .filter({ hasNotText: /prez[aã]o de r\$/i });
  const candidates = [
    valueCard.filter({ hasText: /b[oô]nus|recomendado|v[aá]l/i }).first(),
    page.getByRole('button', { name: valRe }).first(),
    page.getByRole('radio', { name: valRe }).first(),
    valueCard.first(),
    page.getByText(valRe).first(),
  ];
  for (const loc of candidates) {
    try {
      if ((await loc.count()) === 0) continue;
      await loc.waitFor({ state: 'visible', timeout: 5000 });
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      if (doubleTap) {
        await loc.click({ timeout: config.actionTimeoutMs, force: true });
        await sleep(350);
        await loc.click({ timeout: config.actionTimeoutMs, force: true });
      } else {
        await loc.click({ timeout: config.actionTimeoutMs, force: true });
      }
      await dismissBonusModalIfVisible(page).catch(() => {});
      return true;
    } catch {
      // próximo
    }
  }
  const clicked = await page.evaluate((valor) => {
    const re = new RegExp(`R\\$\\s*${valor}(?:,00)?\\b`);
    const skip = /renove seu prez|prez[aã]o de r\$/i;
    const nodes = [...document.querySelectorAll('button, [role="button"], [role="radio"], label, a, div, span')];
    const hits = nodes.filter((n) => {
      const t = (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length >= 120 || skip.test(t)) return false;
      return re.test(t);
    });
    const prefer = hits.find((n) => /b[oô]nus|recomendado|escolha um valor/i.test(n.innerText || '')) || hits[0];
    if (!prefer) return false;
    const findClickable = (el) => {
      let node = el;
      for (let i = 0; i < 7 && node; i += 1) {
        const tag = node.tagName?.toLowerCase() || '';
        const role = node.getAttribute?.('role') || '';
        if (tag === 'button' || tag === 'a' || role === 'button' || role === 'radio') return node;
        node = node.parentElement;
      }
      return el;
    };
    findClickable(prefer).click();
    return true;
  }, rechargeValue);
  if (clicked) {
    await dismissBonusModalIfVisible(page).catch(() => {});
    return true;
  }
  throw new Error(`Valor R$ ${rechargeValue} não disponível na Claro.`);
};

const checkoutIsReady = async (page, gateCapture, sinceTs) =>
  (await hasSmartCheckout(page)) || hasSmartCheckoutApiCall(gateCapture, sinceTs);

/** Abre modal "Como deseja pagar?" — no máx. 2 tentativas por sessão (evita loop infinito). */
async function openPaymentMethodModal(page, session, rechargeValue, sinceTs) {
  if (await detectPaymentMethodModal(page)) return true;
  if (sinceTs && hasSmartCheckoutApiCall(session.gateCapture, sinceTs)) return false;

  session.checkoutModalAttempts = session.checkoutModalAttempts ?? 0;
  if (session.checkoutModalAttempts >= 2) return false;
  session.checkoutModalAttempts += 1;

  console.log(`[automation] abrindo modal pagamento (tentativa ${session.checkoutModalAttempts}/2)…`);

  if (await waitForPaymentMethodModal(page, 2000)) return true;

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await sleep(250);
  await confirmProceedAfterValue(page);
  if (await waitForPaymentMethodModal(page, 2000)) return true;

  const hasPrezao = await hasPrezaoBanner(page);
  if (hasPrezao) {
    await clickPrezaoRenewBanner(page, session, rechargeValue);
    if (await waitForPaymentMethodModal(page, 3000)) return true;
  }

  if (await isRechargeValueSelected(page, rechargeValue)) {
    console.log('[automation] valor selecionado — clique para abrir pagamento…');
    await confirmProceedAfterValue(page);
    if (await waitForPaymentMethodModal(page, 2000)) return true;
    if (!hasPrezao) {
      await clickValueGridCard(page, session, rechargeValue);
    } else {
      await clickPrezaoRenewBanner(page, session, rechargeValue);
    }
    if (await waitForPaymentMethodModal(page, 3000)) return true;
  } else if (!sinceTs || !hasSmartCheckoutApiCall(session.gateCapture, sinceTs)) {
    console.log('[automation] valor não selecionado — clicando grade/banner…');
    if (hasPrezao) {
      await clickPrezaoRenewBanner(page, session, rechargeValue);
    } else {
      await clickValueGridCard(page, session, rechargeValue);
    }
    if (await waitForPaymentMethodModal(page, 3000)) return true;
  }

  await confirmProceedAfterValue(page);
  return waitForPaymentMethodModal(page, 2000);
}

/** Só escolhe Cartão de Crédito se o modal já estiver aberto. */
async function advanceToEldoradoCheckout(page, session, rechargeValue, sinceTs) {
  if (sinceTs && (await checkoutIsReady(page, session.gateCapture, sinceTs))) return true;
  if (await detectPaymentMethodModal(page)) {
    await selectCreditCardPaymentMethod(page, session);
  }
  return false;
}

/** Após valor: modal pagamento (Prezão) ou Eldorado direto (grade). */
async function proceedToCheckoutAfterValue(page, session, rechargeValue, sinceTs) {
  if (await checkoutIsReady(page, session.gateCapture, sinceTs)) return;
  if (hasSmartCheckoutApiCall(session.gateCapture, sinceTs)) {
    await advanceToEldoradoCheckout(page, session, rechargeValue, sinceTs);
    return;
  }
  await sleep(config.pauseAfterValueMs);
  await openPaymentMethodModal(page, session, rechargeValue, sinceTs);
  await advanceToEldoradoCheckout(page, session, rechargeValue, sinceTs);
}

/** Espera iframe Eldorado após escolher valor (modal bônus atrapalha). */
async function waitForCheckoutAfterValue(page, session, rechargeValue, sinceTs) {
  setSessionStep(session, 'smart_checkout', 'Aguardando checkout abrir…');
  const started = Date.now();
  const deadline = started + config.checkoutOpenTimeoutMs;
  let lastLog = 0;

  let lastNudge = 0;

  while (Date.now() < deadline) {
    await advanceToEldoradoCheckout(page, session, rechargeValue, sinceTs);
    await dismissBlockingModals(page).catch(() => {});
    if (await checkoutIsReady(page, session.gateCapture, sinceTs)) return true;
    if (hasSmartCheckoutApiCall(session.gateCapture, sinceTs) && (await hasSmartCheckout(page))) {
      return true;
    }
    if (await detectPixOnlyCheckout(page)) {
      throw new Error('Valor não disponível nesse número (somente Pix).');
    }
    const elapsed = Date.now() - started;
    if (
      elapsed - lastNudge > 12000 &&
      !(await detectPaymentMethodModal(page)) &&
      !hasSmartCheckoutApiCall(session.gateCapture, sinceTs)
    ) {
      await openPaymentMethodModal(page, session, rechargeValue, sinceTs);
      lastNudge = elapsed;
    }
    if (elapsed - lastLog > 8000) {
      const apiHit = hasSmartCheckoutApiCall(session.gateCapture, sinceTs);
      console.log(
        `[automation] aguardando checkout… ${Math.round(elapsed / 1000)}s ` +
          `api=${apiHit ? 'ok' : 'pendente'} url=${(page.url() || '').slice(0, 80)}`,
      );
      lastLog = elapsed;
    }
    await sleep(config.pollIntervalMs);
  }

  await advanceToEldoradoCheckout(page, session, rechargeValue, sinceTs);
  await dismissBlockingModals(page).catch(() => {});
  if (await checkoutIsReady(page, session.gateCapture, sinceTs)) return true;
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
  await dismissBlockingModals(page);

  const checkoutApiSince = Date.now();

  const { source, clicked: valueClicked } = await selectRechargeValue(page, session, rechargeValue);
  if (!valueClicked) {
    throw new Error(`Valor R$ ${rechargeValue} não disponível na Claro.`);
  }
  console.log(`[automation] valor selecionado via ${source}`);

  await proceedToCheckoutAfterValue(page, session, rechargeValue, checkoutApiSince);

  const checkoutOk = await waitForCheckoutAfterValue(page, session, rechargeValue, checkoutApiSince);
  if (!checkoutOk) {
    const { saveStallDebug } = await import('./debug.mjs');
    await saveStallDebug(page, session, session.gateCapture, 'checkout_nao_abriu', {
      rechargeValue,
      url: page.url(),
      smartcheckoutApi: hasSmartCheckoutApiCall(session.gateCapture, checkoutApiSince),
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
      gateResponseBody: paymentResult.gateResponse?.body ?? null,
      gateResponseUrl: paymentResult.gateResponse?.url ?? null,
      gateHttpStatus: paymentResult.gateResponse?.httpStatus ?? null,
    }).catch(() => {});
  } else {
    const dbg = paymentResult?.debug;
    const hint = dbg?.jsonPath ? ` (debug: ${dbg.jsonPath})` : paymentResult?.debug?.jsonPath ? ` (debug: ${paymentResult.debug.jsonPath})` : '';
    setSessionStep(session, 'timeout', `${paymentResult?.message || 'Timeout no pagamento'}${hint}`);
  }
  return paymentResult;
};
