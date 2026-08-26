export function normalizeMinhaClaroWebLink(url) {
  const u = String(url ?? '').trim();
  if (!u) return u;
  return u.replace(/\/controle_web\//gi, '/minhaclaro_web/');
}

export async function generateWebLoginLink(_msisdn) {
  throw new Error('generateWebLoginLink não disponível neste bridge — use link JWT no bot');
}
