import { config } from './config.mjs';
import { saveStallDebug } from './debug.mjs';

/** URLs típicas de fluxo 3DS (Cardinal, Visa, Eldorado challenge). */
const THREEDS_URL_RE =
  /cardinalcommerce\.com|centinelapi\.|authentication\.cardinal|auth\.visa\.com|secure\.checkout\.visa\.com|ThreeDSecure|\/3ds\/challenge|src\.mastercard\.com\/sdk/i;

/** Texto visível em telas 3DS / SMS do banco. */
const THREEDS_TEXT_RE =
  /verifica[cç][aã]o necess[aá]ria|valida[cç][aã]o de seguran[cç]a|enviar sms|autentica[cç][aã]o.*cart[aã]o|secure code|c[oó]digo.*sms|confirme.*compra|clique em continuar|digite o c[oó]digo|senha.*cart[aã]o|token.*seguran/i;

export const describe3dsKind = (kind, hint = '') => {
  if (kind === 'sms' || /enviar sms/i.test(hint)) {
    return '3DS por SMS — confirme manualmente no Edge (Enviar SMS → CONTINUAR)';
  }
  if (kind === 'challenge_api') {
    return '3DS acionado pelo banco — confirme manualmente no Edge';
  }
  return 'Validação 3DS do cartão — confirme manualmente no Edge';
};

/** Primeira captura de POST/GET Eldorado /3ds/challenge na gate. */
export function get3dsChallengeApiCapture(gateCapture) {
  for (const cap of gateCapture?.captures ?? []) {
    if (/\/3ds\/challenge/i.test(cap.url || '')) return cap;
  }
  return null;
}

/** SMS/código exige ação manual imediata; frictionless/API pode confirmar sozinho. */
export function threedsRequiresImmediateAction(threeDs) {
  if (!threeDs?.detected) return false;
  if (threeDs.kind === 'sms') return true;
  const hint = String(threeDs.hint || '');
  if (/enviar sms|digite o c[oó]digo|c[oó]digo.*sms|token.*seguran/i.test(hint)) return true;
  if (threeDs.kind === 'challenge_api' && !threeDs.uiVisible) return false;
  if (/fa[cç]a uma sele[cç][aã]o|chave ref/i.test(hint)) return true;
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
 * Detecta 3DS: tela visível primeiro; API /3ds/challenge só após threedsUiWaitMs
 * (evita sinalizar 3DS antes do iframe do banco abrir).
 */
export async function detect3dsChallenge(page, gateCapture = null, opts = {}) {
  const uiHit = await scan3dsUiFrames(page);
  if (uiHit) return uiHit;

  for (const cap of gateCapture?.captures ?? []) {
    const u = cap.url || '';
    if (/cardinalcommerce\.com/i.test(u) && /ThreeDSecure|CReq/i.test(u)) {
      return { detected: true, source: 'network', url: u, kind: 'cardinal', uiVisible: true };
    }
  }

  const apiCap = get3dsChallengeApiCapture(gateCapture);
  if (!apiCap) return null;

  const firstSeen = opts.challengeApiFirstSeen ?? apiCap.ts ?? Date.now();
  const waitMs = opts.threedsUiWaitMs ?? config.threedsUiWaitMs ?? 25000;
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

/** Encerra gate-wait cedo quando 3DS aparece (não espera 120s). */
export async function build3dsRequiredResult(page, session, gateCapture, threeDs, waitedMs) {
  const msg = describe3dsKind(threeDs.kind, threeDs.hint || '');
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
    pagamentoErro: false,
    debug: null,
  };
}
