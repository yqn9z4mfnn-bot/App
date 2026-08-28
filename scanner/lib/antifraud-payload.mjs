import { randomUUID } from 'node:crypto';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** Fingerprint mobile (iPhone BR) para payload HTTP Eldorado. */
export function buildMobileDevice(overrides = {}) {
  return {
    id: overrides.id || randomUUID(),
    colorDepth: 32,
    javaEnabled: false,
    language: 'pt-BR',
    screenHeight: 844,
    screenWidth: 390,
    timeZoneOffset: 180,
    userAgent: IPHONE_UA,
    cookiesEnabled: true,
    platform: 'iPhone',
    deviceType: 'mobile',
    browser: 'Mobile Safari',
    type: 'BROWSER',
    ...overrides,
  };
}

/** Simula digitação humana nos campos do checkout Eldorado. */
export function buildSyntheticUserBehaviour(startedAt = Date.now() - 52_000) {
  const t0 = startedAt;
  const fieldTimes = {
    card_number: 16_000 + Math.floor(Math.random() * 14_000),
    name: 7_000 + Math.floor(Math.random() * 7_000),
    expiration_date: 5_500 + Math.floor(Math.random() * 5_500),
    cvv: 3_500 + Math.floor(Math.random() * 4_500),
  };

  const keystrokeEvents = [];
  const formFieldEvents = [];
  const mouseEvents = [];
  const fields = [
    ['card_number', 'pan', 16],
    ['name', 'holder', 10],
    ['expiration_date', 'expirationDate', 5],
    ['cvv', 'cvv', 3],
  ];

  let cursor = t0;
  let mx = 180 + Math.floor(Math.random() * 40);
  let my = 420 + Math.floor(Math.random() * 60);

  for (const [fieldId, target, chars] of fields) {
    formFieldEvents.push({ t: cursor, field_id: fieldId, type: 'focus' });
    mouseEvents.push({ type: 'mousemove', x: mx, y: my, t: cursor });
    cursor += 180 + Math.floor(Math.random() * 420);
    mx += 4 + Math.floor(Math.random() * 18);
    my += 2 + Math.floor(Math.random() * 12);

    for (let i = 0; i < chars; i += 1) {
      keystrokeEvents.push({ type: 'keydown', target, t: cursor });
      cursor += 38 + Math.floor(Math.random() * 95);
      keystrokeEvents.push({ type: 'keyup', target, t: cursor });
      cursor += 28 + Math.floor(Math.random() * 75);
      if (i % 4 === 3) {
        formFieldEvents.push({ t: cursor, field_id: fieldId, type: 'change' });
      }
    }
    formFieldEvents.push({ t: cursor, field_id: fieldId, type: 'blur' });
    cursor += 260 + Math.floor(Math.random() * 520);
  }

  mouseEvents.push({ type: 'click', x: mx, y: my + 120, t: cursor + 400 });

  return {
    mouseEvents,
    formFieldInteractionTime: fieldTimes,
    keystrokeEvents,
    formFieldEvents,
    touchEvents: [],
  };
}

export function buildBrowserPaymentExtras({ invoiceId, isSaved = false, deviceId = null } = {}) {
  const extras = {
    invoices: invoiceId ? [invoiceId] : undefined,
    paymentWallet: 'bemobi',
    device: buildMobileDevice(deviceId ? { id: deviceId } : {}),
    userBehaviour: buildSyntheticUserBehaviour(),
    paymentMethodsShown: {
      credit: true,
      debit: false,
      pix: true,
      pix_itp: false,
      google_pay: false,
      boleto: false,
      apple_pay: true,
      nupay: true,
      click_to_pay: false,
    },
    otherPaymentMethodCollapsed: true,
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
