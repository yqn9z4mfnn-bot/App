import { config, WEB_PORTAL } from './config.mjs';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const normalizeBrMobile = (raw) => {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10) digits = `${digits.slice(0, 2)}9${digits.slice(2)}`;
  return digits;
};

/** Normaliza JWT ou URL para select-login minhaclaro_web. */
export function normalizeMinhaClaroWebLink(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^eyJ/i.test(s)) {
    return `${WEB_PORTAL}/select-login?t=${s}`;
  }
  if (/^https?:\/\//i.test(s)) {
    return s.replace(/\/controle_web\//gi, '/minhaclaro_web/');
  }
  return s;
}

export function splitPamInfo(pamInfo) {
  const rawLine = String(pamInfo ?? '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((v) => v.trim())
    .find((v) => v.length > 0);
  if (!rawLine || !rawLine.includes('|')) {
    throw new Error('PAM inválido. Use formato: PAN|MES|ANO|CVV');
  }
  const parts = rawLine.split('|');
  const pan = String(parts[0] ?? '').replace(/\D/g, '');
  const month = String(parts[1] ?? '').trim();
  const year = String(parts[2] ?? '').trim();
  const cvv = parts[3] ? String(parts[3]).replace(/\D/g, '') : '';
  if (!pan || pan.length < 13 || !month || !year) {
    throw new Error('PAM inválido. Use formato: PAN|MES|ANO|CVV');
  }
  const mm = month.padStart(2, '0');
  const yy = year.length > 2 ? year.slice(-2) : year.padStart(2, '0');
  return { pan, mm, yy, mmYY: `${mm}/${yy}`, cvv: cvv || config.defaultCvv };
}

const FIRST = ['Ana', 'Joao', 'Caio', 'Lia', 'Maya', 'Nina', 'Ivo'];
const LAST = ['Silva', 'Lima', 'Reis', 'Costa', 'Souza', 'Melo', 'Prado'];

export const randomName = (maxLen = 7) => {
  const f = FIRST[Math.floor(Math.random() * FIRST.length)];
  const l = LAST[Math.floor(Math.random() * LAST.length)];
  return `${f} ${l}`.slice(0, maxLen);
};

export const webPortalPath = (suffix) =>
  `${WEB_PORTAL}/${String(suffix || '').replace(/^\//, '')}`;

export const setSessionStep = (session, step, label) => {
  if (!session) return;
  session.step = step;
  session.stepLabel = label;
  session.stepAt = new Date().toISOString();
  session.lastActivityAt = Date.now();
  session.steps = Array.isArray(session.steps) ? session.steps : [];
  session.steps.push({ step, label, at: session.stepAt });
  if (session.steps.length > 40) session.steps.splice(0, session.steps.length - 40);
  console.log(`[automation][step] ${step}: ${label}`);
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const textToFlexibleRegex = (text) => {
  const map = {
    a: '[aáàâãä]', e: '[eéèêë]', i: '[iíìîï]', o: '[oóòôõö]', u: '[uúùûü]', c: '[cç]',
  };
  let out = '';
  for (const ch of String(text)) {
    if (map[ch.toLowerCase()]) out += map[ch.toLowerCase()];
    else if (/\s/.test(ch)) out += '\\s+';
    else out += escapeRegex(ch);
  }
  return new RegExp(out, 'i');
};

export const clickByText = async (page, texts, timeoutMs = config.actionTimeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await dismissCookieBanner(page);
    await dismissBonusModalIfVisible(page).catch(() => {});
    const clickMs = Math.max(400, Math.min(2500, deadline - Date.now()));
    for (const text of texts) {
      const re = textToFlexibleRegex(text);
      const candidates = [
        page.getByRole('button', { name: re }).first(),
        page.getByRole('link', { name: re }).first(),
        page.getByText(re).first(),
      ];
      for (const loc of candidates) {
        try {
          if ((await loc.count()) === 0) continue;
          if (!(await loc.isVisible().catch(() => false))) continue;
          await loc.click({ timeout: clickMs });
          return true;
        } catch {
          // próximo
        }
      }
    }
    await sleep(200);
  }
  return false;
};

export const dismissCookieBanner = async (page) => {
  const oneTrustCandidates = [
    page.locator('#onetrust-accept-btn-handler').first(),
    page.getByRole('button', { name: /aceitar\s+cookies/i }).first(),
    page.getByRole('button', { name: /permitir\s+todos/i }).first(),
  ];
  for (const btn of oneTrustCandidates) {
    if ((await btn.count()) > 0) {
      try {
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 1200, force: true });
          await sleep(250);
          return true;
        }
      } catch {
        // ignore
      }
    }
  }
  return false;
};

export const dismissBonusModalIfVisible = async (page) => {
  const opts = [
    page.getByRole('button', { name: /agora n[aã]o/i }).first(),
    page.getByText(/agora n[aã]o/i).first(),
  ];
  for (const opt of opts) {
    if ((await opt.count()) > 0) {
      try {
        await opt.click({ timeout: 2000 });
        await sleep(250);
        return true;
      } catch {
        // ignore
      }
    }
  }
  return false;
};

/** Fecha modais de bônus, upsell e overlays que bloqueiam o checkout. */
export const dismissBlockingModals = async (page) => {
  if (await detectPaymentMethodModal(page)) return false;

  let dismissed = false;
  dismissed = (await dismissCookieBanner(page)) || dismissed;
  dismissed = (await dismissBonusModalIfVisible(page)) || dismissed;

  const dismissPatterns = [
    /agora n[aã]o/i,
    /n[aã]o,?\s*obrigad/i,
    /continuar sem/i,
    /pular/i,
    /fechar/i,
    /ignorar/i,
  ];
  for (const re of dismissPatterns) {
    const btn = page.getByRole('button', { name: re }).first();
    if ((await btn.count()) === 0) continue;
    try {
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 1500, force: true });
        await sleep(280);
        dismissed = true;
      }
    } catch {
      // ignore
    }
  }

  const closeSelectors = [
    page.locator('[aria-label="Fechar"]').first(),
    page.locator('[aria-label="Close"]').first(),
    page.locator('button[class*="close" i]').first(),
  ];
  for (const close of closeSelectors) {
    if ((await close.count()) === 0) continue;
    try {
      if (await close.isVisible().catch(() => false)) {
        await close.click({ timeout: 1200, force: true });
        await sleep(250);
        dismissed = true;
        break;
      }
    } catch {
      // ignore
    }
  }
  return dismissed;
};

/** Modal intermediário: "Como deseja pagar sua recarga?" */
export const detectPaymentMethodModal = async (page) => {
  try {
    const title = page.getByText(/como deseja pagar/i).first();
    if ((await title.count()) > 0 && (await title.isVisible().catch(() => false))) return true;

    const credit = page.getByText(/cart[aã]o de cr[eé]dito/i).first();
    const pix = page.getByText(/^\s*pix\s*$/i).first();
    if (
      (await credit.count()) > 0 &&
      (await credit.isVisible().catch(() => false)) &&
      (await pix.count()) > 0 &&
      (await pix.isVisible().catch(() => false))
    ) {
      return true;
    }

    return await page.evaluate(() => {
      const t = (document.body?.innerText || '').replace(/\s+/g, ' ');
      return /como deseja pagar/i.test(t) && /cart[aã]o de cr[eé]dito/i.test(t);
    });
  } catch {
    return false;
  }
};

export const waitForPaymentMethodModal = async (page, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await detectPaymentMethodModal(page)) return true;
    await sleep(config.pollIntervalMs);
  }
  return false;
};

const rechargeValueRegex = (valor) => new RegExp(`R\\$\\s*${valor}(?:,00)?(?:\\b|\\+|\\s)`);

const skipPrezaoText = /renove seu prez|prez[aã]o de r\$/i;

/** Lógica da grade de valores — roda no contexto do browser via page.evaluate. */
const valueGridBrowserLogic = ({ valor, mode }) => {
  const re = new RegExp(`R\\$\\s*${valor}(?:,00)?(?:\\b|\\+|\\s)`);
  const primaryRe = new RegExp(`^R\\$\\s*${valor}(?:,00)?\\b`, 'i');
  const skip = /renove seu prez|prez[aã]o de r\$|\(\d{2}\)\s*\d|\boutro n[uú]mero/i;

  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,div,label')].filter((el) => {
    const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return /^escolha um valor de recarga/i.test(t) && t.length < 80;
  });
  const heading = headings[0];
  const root =
    heading?.closest('section, form, main, [class*="value" i], [class*="recarga" i]') ||
    heading?.parentElement?.parentElement ||
    heading?.parentElement ||
    document.body;

  const isRedBorder = (style) => {
    const bc = style.borderColor || '';
    return /rgb\(\s*2(?:2[0-9]|3[0-9]|4[0-9])|rgb\(\s*227|rgb\(\s*237|#e[0-9a-f]{2}/i.test(bc) &&
      parseFloat(style.borderWidth || '0') >= 1.5;
  };

  const looksSelected = (el) => {
    if (!el) return false;
    if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true') return true;
    const cls = String(el.className || '');
    if (/selected|active|checked|highlight|chosen|pressed/i.test(cls)) return true;
    const style = window.getComputedStyle(el);
    if (isRedBorder(style)) return true;
    const parent = el.parentElement;
    if (parent && isRedBorder(window.getComputedStyle(parent))) return true;
    return false;
  };

  const findCard = (el) => {
    let node = el;
    for (let i = 0; i < 6 && node; i += 1) {
      const r = node.getBoundingClientRect();
      if (r.width >= 90 && r.width <= 260 && r.height >= 70 && r.height <= 200) return node;
      node = node.parentElement;
    }
    return el;
  };

  const hits = [];
  for (const el of root.querySelectorAll('button, [role="button"], [role="radio"], label, div, li, span')) {
    const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (skip.test(t) || !re.test(t) || t.length > 75) continue;
    const card = findCard(el);
    const cr = card.getBoundingClientRect();
    if (cr.width < 90 || cr.height < 70) continue;
    const cardText = (card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim();
    if (cardText.length > 75 || skip.test(cardText)) continue;
    hits.push({
      card,
      area: cr.width * cr.height,
      y: cr.top,
      primary: primaryRe.test(cardText),
      text: cardText.slice(0, 60),
      selected: looksSelected(card),
    });
  }

  hits.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return a.area - b.area || a.y - b.y;
  });

  if (mode === 'selected') return hits.some((h) => h.selected);
  if (mode === 'coords') {
    const pick = hits[0]?.card;
    if (!pick) return null;
    const r = pick.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: hits[0].text };
  }
  return null;
};

/** Detecta se o card da grade (não Prezão) está selecionado. */
export const isRechargeValueSelected = async (page, rechargeValue) =>
  page
    .evaluate(valueGridBrowserLogic, { valor: rechargeValue, mode: 'selected' })
    .catch(() => false);

/** Clica no card da grade de valores (ex. R$35 +10GB) — um clique, mouse no centro. */
export const clickValueGridCard = async (page, session, rechargeValue) => {
  if (session) setSessionStep(session, 'valor', `Selecionando valor R$ ${rechargeValue}…`);
  await dismissBlockingModals(page);

  await page
    .evaluate(() => {
      const h = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,div,label')].find((el) =>
        /escolha um valor de recarga/i.test((el.innerText || '').replace(/\s+/g, ' ').trim()),
      );
      h?.scrollIntoView({ block: 'center', behavior: 'instant' });
    })
    .catch(() => {});
  await sleep(350);

  const valRe = rechargeValueRegex(rechargeValue);
  const coords = await page
    .evaluate(valueGridBrowserLogic, { valor: rechargeValue, mode: 'coords' })
    .catch(() => null);

  if (coords) {
    try {
      await page.touchscreen.tap(coords.x, coords.y);
    } catch {
      await page.mouse.click(coords.x, coords.y);
    }
    await sleep(config.pauseAfterClickMs);
    await dismissBonusModalIfVisible(page).catch(() => {});
    console.log(`[automation] clicou grade R$ ${rechargeValue} (tap centro) card="${coords.text}"`);
    return true;
  }

  const valueCard = page
    .locator("button, [role='button'], [role='radio'], label, div, li")
    .filter({ hasText: valRe })
    .filter({ hasNotText: skipPrezaoText });
  const candidates = [
    valueCard.filter({ hasText: /\+|gb|b[oô]nus/i }).first(),
    page.getByRole('button', { name: valRe }).first(),
    page.getByRole('radio', { name: valRe }).first(),
    valueCard.first(),
  ];

  for (const loc of candidates) {
    try {
      if ((await loc.count()) === 0) continue;
      await loc.waitFor({ state: 'visible', timeout: 5000 });
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      const box = await loc.boundingBox().catch(() => null);
      if (box) {
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        try {
          await page.touchscreen.tap(x, y);
        } catch {
          await page.mouse.click(x, y);
        }
      } else {
        await loc.tap({ timeout: config.actionTimeoutMs, force: true }).catch(() =>
          loc.click({ timeout: config.actionTimeoutMs, force: true }),
        );
      }
      await sleep(config.pauseAfterClickMs);
      await dismissBonusModalIfVisible(page).catch(() => {});
      console.log(`[automation] clicou grade R$ ${rechargeValue} (locator)`);
      return true;
    } catch {
      // próximo
    }
  }
  return false;
};

export const hasPrezaoBanner = async (page) => visibleTextMatch(page, /renove seu prez/i);

/** Escolhe valor: banner Prezão (se existir) ou card da grade. */
export const selectRechargeValue = async (page, session, rechargeValue) => {
  await dismissBlockingModals(page);

  if (await hasPrezaoBanner(page)) {
    const prezao = await clickPrezaoRenewBanner(page, session, rechargeValue);
    if (prezao) return { source: 'prezao', clicked: true };
  }

  const grid = await clickValueGridCard(page, session, rechargeValue);
  if (grid) return { source: 'grid', clicked: true };

  return { source: 'none', clicked: false };
};

/** Escolhe Cartão de Crédito no modal de método de pagamento (antes do iframe Eldorado). */
export const selectCreditCardPaymentMethod = async (page, session = null) => {
  if (!(await detectPaymentMethodModal(page))) return false;
  if (session?.creditMethodClicked) return false;

  if (session) setSessionStep(session, 'metodo_pagamento', 'Selecionando Cartão de Crédito…');
  console.log('[automation] modal método de pagamento — clicando Cartão de Crédito');

  const tryClick = async (loc) => {
    if ((await loc.count()) === 0) return false;
    try {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      const box = await loc.boundingBox().catch(() => null);
      if (box && box.height > 8) {
        await loc.click({
          timeout: config.actionTimeoutMs,
          force: true,
          position: { x: Math.min(box.width - 8, Math.max(8, box.width * 0.5)), y: box.height * 0.5 },
        });
      } else {
        await loc.click({ timeout: config.actionTimeoutMs, force: true });
      }
      await sleep(config.pauseAfterClickMs + 400);
      return !(await detectPaymentMethodModal(page));
    } catch {
      return false;
    }
  };

  const rowCandidates = [
    page.getByRole('button', { name: /cart[aã]o de cr[eé]dito/i }).first(),
    page.getByRole('radio', { name: /cart[aã]o de cr[eé]dito/i }).first(),
    page.locator('li, button, [role="button"], a, div').filter({ hasText: /^cart[aã]o de cr[eé]dito$/i }).first(),
    page.locator('li, button, [role="button"], a, div').filter({ hasText: /cart[aã]o de cr[eé]dito/i }).filter({ hasNotText: /pix/i }).first(),
    page.getByText(/^cart[aã]o de cr[eé]dito$/i).first(),
  ];

  for (const loc of rowCandidates) {
    if (await tryClick(loc)) {
      if (session) session.creditMethodClicked = true;
      return true;
    }
  }

  const viaEval = await page
    .evaluate(() => {
      const matches = [];
      for (const el of document.querySelectorAll('button, [role="button"], li, a, div, span')) {
        const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/^cart[aã]o de cr[eé]dito$/i.test(t) && !/cart[aã]o de cr[eé]dito/i.test(t)) continue;
        if (/pix/i.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 60 || r.height < 20) continue;
        matches.push({ el, area: r.width * r.height, y: r.top });
      }
      matches.sort((a, b) => a.y - b.y || a.area - b.area);
      const pick = matches[0]?.el;
      if (!pick) return false;
      const clickable =
        pick.closest('button, [role="button"], li, a') ||
        pick.parentElement ||
        pick;
      clickable.click();
      return true;
    })
    .catch(() => false);

  if (viaEval) {
    await sleep(config.pauseAfterClickMs + 500);
    if (!(await detectPaymentMethodModal(page))) {
      if (session) session.creditMethodClicked = true;
      return true;
    }
  }

  return false;
};

/** Banner "Renove seu Prezão" — números Prezão abrem checkout por aqui (ex. 21992358933). */
export const clickPrezaoRenewBanner = async (page, session, rechargeValue) => {
  const hasBanner = await visibleTextMatch(page, /renove seu prez/i);
  if (!hasBanner) return false;

  const valRe = new RegExp(`R\\$\\s*${rechargeValue}(?:,00)?\\b`);
  const banner = page
    .locator('button, [role="button"], a, div')
    .filter({ hasText: /renove seu prez/i })
    .filter({ hasText: valRe })
    .first();

  if ((await banner.count()) > 0) {
    try {
      await banner.scrollIntoViewIfNeeded().catch(() => {});
      await banner.click({ timeout: config.actionTimeoutMs, force: true });
      if (session) setSessionStep(session, 'valor', `Renove Prezão R$ ${rechargeValue}…`);
      console.log('[automation] clicou banner Renove seu Prezão');
      await sleep(config.pauseAfterClickMs);
      return true;
    } catch {
      // fallback evaluate
    }
  }

  const clicked = await page
    .evaluate((valor) => {
      const re = new RegExp(`R\\$\\s*${valor}(?:,00)?\\b`);
      for (const el of document.querySelectorAll('button, [role="button"], a, div')) {
        const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/renove seu prez/i.test(t) || !re.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 24) continue;
        el.click();
        return true;
      }
      return false;
    }, rechargeValue)
    .catch(() => false);

  if (clicked) {
    if (session) setSessionStep(session, 'valor', `Renove Prezão R$ ${rechargeValue}…`);
    console.log('[automation] clicou banner Renove seu Prezão (evaluate)');
    await sleep(config.pauseAfterClickMs);
  }
  return clicked;
};

/** Após escolher valor — Continuar (não fecha modal de pagamento). */
export const confirmProceedAfterValue = async (page) => {
  if (await detectPaymentMethodModal(page)) return false;
  await dismissBlockingModals(page);
  return clickByText(
    page,
    [
      'Continuar',
      'Avançar',
      'Ir para pagamento',
      'Confirmar',
      'Pagar',
      'Recarregar agora',
      'Finalizar',
    ],
    4000,
  );
};

export const visibleTextMatch = async (page, re) =>
  page.evaluate((pattern) => new RegExp(pattern, 'i').test(document.body?.innerText || ''), re.source);

export const isWebPortalAuthed = (url) =>
  /\/minhaclaro_web\/(numero|home|pagamento|meus-dados|landing|smartcheckout|confirmacao-beneficio)/i.test(
    url || '',
  );

export const isPaymentSuccessUrl = (url) =>
  /pagamento-sucesso|confirmacao-beneficio|sucesso/i.test(String(url || ''));

export const isPaymentErrorUrl = (url) => /pagamento-erro|erro/i.test(String(url || ''));

export const hasAuthenticatedUiMarkers = async (page) =>
  page
    .evaluate(() => {
      const t = document.body?.innerText || '';
      return (
        /fazer recarga/i.test(t) ||
        /escolha um valor/i.test(t) ||
        /meus dados/i.test(t) ||
        /R\$\s*\d{1,3}/.test(t)
      );
    })
    .catch(() => false);

export const waitForWebPortalAuth = async (page, timeoutMs = 45000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const u = page.url() || '';
    if (/\/select-login/i.test(u)) {
      await sleep(config.pollIntervalMs);
      continue;
    }
    if (isWebPortalAuthed(u)) return true;
    if (await hasAuthenticatedUiMarkers(page)) return true;
    await sleep(config.pollIntervalMs);
  }
  return false;
};

export const clickInAnyFrame = async (page, labels, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      for (const label of labels) {
        try {
          const btn = frame.getByRole('button', { name: new RegExp(label, 'i') }).first();
          if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
            await btn.click({ timeout: 2000 });
            return true;
          }
        } catch {
          // ignore
        }
      }
    }
    await sleep(config.pollIntervalMs);
  }
  return false;
};
