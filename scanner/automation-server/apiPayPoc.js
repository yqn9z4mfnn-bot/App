/** Apenas para log — a URL /3ds/challenge é chamada em todo fluxo Braspag. */
export function gateCaptureHas3dsChallenge(gateCapture) {
  const caps = gateCapture?.captures ?? [];
  for (let i = caps.length - 1; i >= 0; i -= 1) {
    const url = String(caps[i]?.url ?? '');
    if (/\/3ds\/challenge/i.test(url)) {
      const brand = url.match(/brand=([A-Z]+)/i)?.[1] ?? 'CARD';
      return { brand, capture: caps[i] };
    }
  }
  return null;
}

/**
 * Suprime challenge 3DS (Braspag MPI) — igual ao sistema original que chegava na gate.
 * bpmpi_auth_suppresschallenge=true evita modal manual na maioria dos cartões.
 */
export function attachEldorado3dsBypass(context) {
  const initScript = () => {
    const suppress = () => {
      try {
        for (const el of document.querySelectorAll('input[name="bpmpi_auth_suppresschallenge"]')) {
          el.value = 'true';
          el.setAttribute('value', 'true');
        }
        if (typeof window.bpmpi_config === 'object' && window.bpmpi_config) {
          window.bpmpi_config.authSuppressChallenge = true;
        }
        if (typeof window.BPMPi === 'object' && window.BPMPi) {
          window.BPMPi.config = { ...(window.BPMPi.config || {}), authSuppressChallenge: true };
        }
      } catch {
        /* ignore cross-origin */
      }
    };

    suppress();
    const obs = new MutationObserver(suppress);
    if (document.documentElement) {
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    }
    window.addEventListener('load', suppress, true);
    setInterval(suppress, 500);
  };

  context.addInitScript(initScript);

  const onFrameNavigated = (frame) => {
    frame.evaluate(initScript).catch(() => {});
  };

  context.on('framenavigated', onFrameNavigated);

  console.log('[claro][3ds] bypass ativo — bpmpi_auth_suppresschallenge=true');

  return {
    detach: () => {
      try {
        context.off('framenavigated', onFrameNavigated);
      } catch {
        /* ignore */
      }
    },
  };
}

export async function tryApiDirectEldoradoPay() {
  return null;
}

export function isGateRequestCaptureUrl(url) {
  return /\/api-bsc\/api\/v1\/payments/i.test(String(url || ''));
}
