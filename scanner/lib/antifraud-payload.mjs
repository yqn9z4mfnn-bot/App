import { randomUUID } from 'node:crypto';

/** Fingerprint mobile (iPhone) para o payload de pagamento da API Eldorado. */
export function buildMobileDevice() {
  return {
    id: randomUUID(),
    colorDepth: 32,
    javaEnabled: false,
    language: 'pt-BR',
    screenHeight: 844,
    screenWidth: 390,
    timeZoneOffset: 180,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    cookiesEnabled: true,
    platform: 'iPhone',
    deviceType: 'mobile',
    browser: 'Mobile Safari',
    type: 'BROWSER',
  };
}

/** Simula digitação humana nos campos do checkout Eldorado. */
export function buildSyntheticUserBehaviour() {
  const t0 = Date.now() - 45_000;
  const fieldTimes = {
    card_number: 18_000 + Math.floor(Math.random() * 12_000),
    name: 8_000 + Math.floor(Math.random() * 6_000),
    expiration_date: 6_000 + Math.floor(Math.random() * 5_000),
    cvv: 4_000 + Math.floor(Math.random() * 4_000),
  };

  const keystrokeEvents = [];
  const formFieldEvents = [];
  const fields = [
    ['card_number', 'pan', 16],
    ['name', 'holder', 12],
    ['expiration_date', 'expirationDate', 5],
    ['cvv', 'cvv', 3],
  ];

  let cursor = t0;
  for (const [fieldId, target, chars] of fields) {
    formFieldEvents.push({ t: cursor, field_id: fieldId, type: 'focus' });
    cursor += 200 + Math.floor(Math.random() * 400);
    for (let i = 0; i < chars; i += 1) {
      keystrokeEvents.push({ type: 'keydown', target, t: cursor });
      cursor += 40 + Math.floor(Math.random() * 120);
      keystrokeEvents.push({ type: 'keyup', target, t: cursor });
      cursor += 30 + Math.floor(Math.random() * 90);
      if (i % 4 === 3) {
        formFieldEvents.push({ t: cursor, field_id: fieldId, type: 'change' });
      }
    }
    formFieldEvents.push({ t: cursor, field_id: fieldId, type: 'blur' });
    cursor += 300 + Math.floor(Math.random() * 500);
  }

  return {
    mouseEvents: [],
    formFieldInteractionTime: fieldTimes,
    keystrokeEvents,
    formFieldEvents,
  };
}

export function buildBrowserPaymentExtras({ invoiceId, isSaved = false } = {}) {
  const extras = {
    invoices: invoiceId ? [invoiceId] : undefined,
    paymentWallet: 'bemobi',
    device: buildMobileDevice(),
    userBehaviour: buildSyntheticUserBehaviour(),
    paymentMethodsShown: {
      credit: true,
      debit: false,
      pix: true,
      pix_itp: false,
      google_pay: true,
      boleto: false,
      apple_pay: true,
      nupay: true,
      click_to_pay: true,
    },
    otherPaymentMethodCollapsed: false,
  };

  if (!isSaved) {
    Object.assign(extras, {
      saveCard: true,
      saveRecurrence: false,
      walletEnabled: true,
      autoSaveCardEnabled: true,
      autoRecurrenceOptIn: false,
      allowMultipleCardOptIn: false,
    });
  }

  return extras;
}
