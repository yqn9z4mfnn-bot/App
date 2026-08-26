export async function tryApiDirectEldoradoPay() {
  return null;
}

export function isGateRequestCaptureUrl(url) {
  return /\/api-bsc\/api\/v1\/payments/i.test(String(url || ''));
}
