import { config } from './config.mjs';
import { sleep } from './helpers.mjs';

const ANTIFRAUD_URL_RE =
  /thm\.visa\.com|geo\.cardinalcommerce\.com|centinelapi\.|eldorado\.m4u\.com\.br\/v1\/ip|devicefingerprint/i;

/** Aguarda scripts de fingerprint (Visa/Cardinal) antes de preencher cartão. */
export const waitForCheckoutAntifraud = async (page, timeoutMs = null) => {
  const ms = timeoutMs ?? config.antifraudWaitMs ?? 3500;
  const deadline = Date.now() + ms;
  let saw = 0;
  const onResponse = (res) => {
    if (ANTIFRAUD_URL_RE.test(res.url())) saw += 1;
  };
  page.on('response', onResponse);
  try {
    while (Date.now() < deadline) {
      if (saw >= 2) break;
      await sleep(120);
    }
    await sleep(config.antifraudSettleMs ?? 280);
  } finally {
    page.off('response', onResponse);
  }
  return saw;
};

const jitter = (base, spread = 0.35) =>
  Math.round(base * (1 - spread / 2 + Math.random() * spread));

/** Pequenos movimentos de toque antes de pagar (mobile checkout). */
export const simulatePrePayInteraction = async (page) => {
  if (!config.antifraudPrePayMotion) return;
  try {
    const vp = page.viewportSize() || { width: 390, height: 844 };
    const x = Math.floor(vp.width * (0.35 + Math.random() * 0.3));
    const y = Math.floor(vp.height * (0.45 + Math.random() * 0.15));
    await page.mouse.move(x, y);
    await sleep(jitter(180, 0.5));
    await page.mouse.move(x + jitter(12, 1), y + jitter(8, 1));
    await sleep(jitter(120, 0.5));
  } catch {
    // ignore headless quirks
  }
};

const typeFieldHuman = async (locator, text, delayMs) => {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ force: true, timeout: 5000 });
  await sleep(jitter(90, 0.6));
  await locator.fill('');
  await locator.pressSequentially(String(text), { delay: delayMs });
  await sleep(jitter(140, 0.5));
  await locator.dispatchEvent('blur').catch(() => {});
};

/** Preenche PAN/validade/CVV/nome com timing humano (melhor score antifraude). */
export const fillCardFieldsHuman = async (locators, pam, holderName) => {
  const delay = config.pamTypingDelayMs ?? 35;
  const pan = String(pam.pan).replace(/\D/g, '');
  await typeFieldHuman(locators.pan, pan, delay);
  await sleep(jitter(config.antifraudFieldGapMs ?? 220, 0.45));
  await typeFieldHuman(locators.holder, holderName, Math.max(28, delay - 5));
  await sleep(jitter(config.antifraudFieldGapMs ?? 220, 0.45));
  await typeFieldHuman(locators.expiration, String(pam.mmYY), delay);
  await sleep(jitter(config.antifraudFieldGapMs ?? 220, 0.45));
  await typeFieldHuman(locators.cvv, String(pam.cvv || config.defaultCvv), delay + 8);
};
