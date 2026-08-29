import { config } from './config.mjs';
import { saveStallDebug } from './debug.mjs';
import {
  isCheckoutErrorText,
  isCheckoutErrorUrl,
  overrideThreedsIfCheckoutError,
} from '../lib/checkout-error.mjs';

/** URLs típicas de fluxo 3DS (Cardinal, Visa, Eldorado challenge). */
const THREEDS_URL_RE =
  /cardinalcommerce\.com|centinelapi\.|authentication\.cardinal|auth\.visa\.com|secure\.checkout\.visa\.com|ThreeDSecure|\/3ds\/challenge|src\.mastercard\.com\/sdk/i;

/** Texto visível em telas 3DS / SMS do banco. */
const THREEDS_TEXT_RE =
  /verifica[cç][aã]o necess[aá]ria|valida[cç][aã]o de seguran[cç]a|enviar sms|autentica[cç][aã]o.*cart[aã]o|secure code|c[oó]digo.*sms|confirme.*compra|clique em continuar|digite o c[oó]digo|senha.*cart[aã]o|token.*seguran/i;

export const describe3dsKind = (kind, hint = '', opts = {}) => {
  const browserOpen = opts.browserOpen === true;
  if (kind === 'sms' || /enviar sms/i.test(hint)) {
    return browserOpen
      ? '3DS por SMS — confirme no Edge (Enviar SMS → CONTINUAR)'
      : '3DS por SMS — aprove no app/SMS do banco (Edge fechado)';
  }
  if (kind === 'cardinal' || /verifica[cç][aã]o necess[aá]ria|valida[cç][aã]o de seguran[cç]a/i.test(hint)) {
    return browserOpen
      ? 'VBV/3DS visual — confirme manualmente no Edge'
      : 'VBV visual — aprove no app/SMS do banco (Edge fechado)';
  }
  if (kind === 'challenge_api') {
    return '3DS frictionless — aguardando confirmação automática';
  }
  return browserOpen
    ? 'Validação 3DS do cartão — confirme manualmente no Edge'
    : 'Validação 3DS — aprove no banco (Edge fechado)';
};

/** Primeira captura de POST/GET Eldorado /3ds/challenge na gate. */
export function get3dsChallengeApiCapture(gateCapture) {
  for (const cap of gateCapture?.captures ?? []) {
    if (/\/3ds\/challenge/i.test(cap.url || '')) return cap;
  }
  return null;
}

/** VBV/3DS com tela visível (iframe Cardinal, CReq, texto SMS, etc.). */
export function isVisualVbv(threeDs) {
  if (!threeDs?.detected) return false;
  if (isCheckoutErrorText(threeDs.hint)) return false;
  if (threeDs.uiVisible === true && threeDs.hint && THREEDS_TEXT_RE.test(threeDs.hint)) return true;
  if (threeDs.kind === 'sms') return true;
  const url = String(threeDs.url || '');
  if (/ThreeDSecure\/V2|\/CReq|authentication\.cardinal.*CReq/i.test(url)) return true;
  const hint = String(threeDs.hint || '');
  if (THREEDS_TEXT_RE.test(hint)) return true;
  return false;
}

/** VBV visual / SMS → para na hora; API frictionless continua gate-wait. */
export function threedsRequiresImmediateAction(threeDs) {
  if (!threeDs?.detected) return false;
  if (isVisualVbv(threeDs)) return true;
  if (threeDs.kind === 'sms') return true;
  const hint = String(threeDs.hint || '');
  if (/enviar sms|digite o c[oó]digo|c[oó]digo.*sms|token.*seguran/i.test(hint)) return true;
  if (threeDs.kind === 'challenge_api' && !threeDs.uiVisible) return false;
  return false;
}

/** Procura iframe/tela 3DS visível (prioridade sobre API). */
async function scan3dsUiFrames(page) {
  for (const frame of page.frames()) {
    const frameUrl = frame.url() || '';
    if (!THREEDS_URL_RE.test(frameUrl)) continue;

    let text = '';
    try {
      text = await frame.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim());
    } catch {
      if (/ThreeDSecure\/V2|\/CReq/i.test(frameUrl)) {
        return { detected: true, source: 'frame_url', url: frameUrl, kind: 'cardinal', uiVisible: true };
      }
      continue;
    }

    if (!text && !/ThreeDSecure\/V2|\/CReq/i.test(frameUrl)) continue;
    if (isCheckoutErrorText(text)) return null;

    const isSms = /enviar sms/i.test(text);
    const is3dsUi = THREEDS_TEXT_RE.test(text) || /ThreeDSecure\/V2|\/CReq/i.test(frameUrl);
    if (!is3dsUi) continue;

    return {
      detected: true,
      source: 'frame',
      url: frameUrl,
      kind: isSms ? 'sms' : 'cardinal',
      hint: text.slice(0, 400),
      uiVisible: true,
    };
  }
  return null;
}

/**
 * Detecta 3DS: tela visível primeiro; API /3ds/challenge só após threedsUiWaitMs
 * (tempo curto para ver se abre VBV antes de tratar como frictionless).
 */
export async function detect3dsChallenge(page, gateCapture = null, opts = {}) {
  try {
    if (isCheckoutErrorUrl(page?.url?.())) return null;
  } catch {
    // page já fechada
  }

  const uiHit = await scan3dsUiFrames(page);
  if (uiHit) return uiHit;

  for (const cap of gateCapture?.captures ?? []) {
    const u = cap.url || '';
    if (/cardinalcommerce\.com/i.test(u) && /ThreeDSecure\/V2|\/CReq/i.test(u)) {
      return { detected: true, source: 'network', url: u, kind: 'cardinal', uiVisible: true };
    }
  }

  const apiCap = get3dsChallengeApiCapture(gateCapture);
  if (!apiCap) return null;

  const firstSeen = opts.challengeApiFirstSeen ?? apiCap.ts ?? Date.now();
  const waitMs = opts.threedsUiWaitMs ?? config.threedsUiWaitMs ?? 8000;
  const elapsedSinceApi = Date.now() - firstSeen;

  if (elapsedSinceApi < waitMs) return null;

  return {
    detected: true,
    source: 'api',
    url: apiCap.url,
    kind: 'challenge_api',
    uiVisible: false,
    waitedForUiMs: elapsedSinceApi,
  };
}

/** Encerra gate-wait quando 3DS exige ação ou frictionless expirou. */
export async function build3dsRequiredResult(page, session, gateCapture, threeDs, waitedMs, opts = {}) {
  const browserOpen = opts.browserOpen === true;
  const msg = describe3dsKind(threeDs.kind, threeDs.hint || '', { browserOpen });
  console.log(
    `[automation][3ds] detectado em ${Math.round(waitedMs / 1000)}s ` +
      `kind=${threeDs.kind} source=${threeDs.source} ui=${threeDs.uiVisible !== false ? 'sim' : 'nao'} ` +
      `url=${String(threeDs.url).slice(0, 100)}`,
  );
  if (threeDs.hint) {
    console.log(`[automation][3ds] tela: ${threeDs.hint.slice(0, 160)}`);
  }

  if (session) {
    void saveStallDebug(page, session, gateCapture, 'gate_3ds', {
      waitedMs,
      threeDs,
    }).catch(() => {});
  }

  const pageUrl = page?.url?.() ?? '';
  return overrideThreedsIfCheckoutError(
    {
      status: '3ds_required',
      url: pageUrl,
      gateCode: '3DS',
      gateMessage: msg,
      message: msg,
      threeDs,
      visualVbv: isVisualVbv(threeDs),
      requiresImmediateAction: threedsRequiresImmediateAction(threeDs),
      pagamentoErro: false,
      debug: null,
    },
    { url: pageUrl, text: threeDs.hint },
  );
}
