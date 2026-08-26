/** Detecta challenge 3DS na captura de rede (Eldorado/Braspag). */
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

export async function tryApiDirectEldoradoPay() {
  return null;
}

export function isGateRequestCaptureUrl(url) {
  return /\/api-bsc\/api\/v1\/payments/i.test(String(url || ''));
}
