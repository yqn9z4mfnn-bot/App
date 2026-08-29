import { saveStallDebug } from './debug.mjs';

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
    return '3DS acionado pelo banco — confirme no app/SMS do banco';
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

/** VBV/3DS com tela visível (iframe Cardinal, CReq, etc.). */
export function isVisualVbv(threeDs) {
  if (!threeDs?.detected) return false;
  if (threeDs.uiVisible === true) return true;
  if (threeDs.kind === 'cardinal') return true;
  const url = String(threeDs.url || '');
  if (/ThreeDSecure|\/CReq|authentication\.cardinal/i.test(url)) return true;
  const hint = String(threeDs.hint || '');
  if (THREEDS_TEXT_RE.test(hint)) return true;
  return false;
}

/** VBV visual / SMS → para na hora; frictionless API só se THREEDS_CONTINUE_GATE_WAIT=0. */
export function threedsRequiresImmediateAction(threeDs) {
  if (!threeDs?.detected) return false;
  if (isVisualVbv(threeDs)) return true;
  if (threeDs.kind === 'sms') return true;
  const hint = String(threeDs.hint || '');
  if (/enviar sms|digite o c[oó]digo|c[oó]digo.*sms|token.*seguran/i.test(hint)) return true;
  if (threeDs.kind === 'challenge_api' && !threeDs.uiVisible) return false;
  return true;
}

/** Detecção síncrona — rede + URL de iframe (sem evaluate lento). */
export function detect3dsFast(page, gateCapture = null) {
  for (const cap of gateCapture?.captures ?? []) {
    const u = cap.url || '';
    if (/cardinalcommerce\.com/i.test(u) && /ThreeDSecure|CReq|centinelapi/i.test(u)) {
      return { detected: true, source: 'network', url: u, kind: 'cardinal', uiVisible: true };
    }
    if (/auth\.visa\.com|secure\.checkout\.visa\.com/i.test(u) && /ThreeDSecure|CReq|oauth2/i.test(u)) {
      return { detected: true, source: 'network', url: u, kind: 'cardinal', uiVisible: true };
    }
    if (/\/3ds\/challenge/i.test(u)) {
      return { detected: true, source: 'api', url: u, kind: 'challenge_api', uiVisible: false };
    }
  }

  if (page) {
    for (const frame of page.frames()) {
      const u = frame.url() || '';
      if (!THREEDS_URL_RE.test(u)) continue;
      if (/ThreeDSecure|CReq|3ds\/challenge|auth\.visa\.com\/oauth2|cardinalcommerce/i.test(u)) {
        return { detected: true, source: 'frame_url', url: u, kind: 'cardinal', uiVisible: true };
      }
    }
  }

  return null;
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
      if (/ThreeDSecure|CReq|3ds\/challenge|auth\.visa\.com\/oauth2/i.test(frameUrl)) {
        return { detected: true, source: 'frame_url', url: frameUrl, kind: 'cardinal', uiVisible: true };
      }
      continue;
    }

    if (!text && !/ThreeDSecure|CReq|auth\.visa\.com\/oauth2/i.test(frameUrl)) continue;

    const isSms = /enviar sms/i.test(text);
    const is3dsUi = THREEDS_TEXT_RE.test(text) || /ThreeDSecure|CReq/i.test(frameUrl);
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
 * Detecta 3DS: tela visível primeiro; API /3ds/challenge → para na hora.
 */
export async function detect3dsChallenge(page, gateCapture = null, opts = {}) {
  const fast = detect3dsFast(page, gateCapture);
  if (fast) return fast;

  const uiHit = await scan3dsUiFrames(page);
  if (uiHit) return uiHit;

  const apiCap = get3dsChallengeApiCapture(gateCapture);
  if (!apiCap) return null;

  return {
    detected: true,
    source: 'api',
    url: apiCap.url,
    kind: 'challenge_api',
    uiVisible: false,
    waitedForUiMs: 0,
  };
}

/** Encerra gate-wait cedo quando 3DS aparece (não espera 120s). */
export async function build3dsRequiredResult(page, session, gateCapture, threeDs, waitedMs, opts = {}) {
  const browserOpen = opts.browserOpen === true;
  const visualVbv = isVisualVbv(threeDs);
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

  return {
    status: '3ds_required',
    url: page.url(),
    gateCode: '3DS',
    gateMessage: msg,
    message: msg,
    threeDs,
    visualVbv,
    requiresImmediateAction: threedsRequiresImmediateAction(threeDs),
    pagamentoErro: false,
    debug: null,
  };
}
