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

/** Após escolher valor — alguns fluxos exigem Continuar antes do iframe Eldorado. */
export const confirmProceedAfterValue = async (page) => {
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
    6000,
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
