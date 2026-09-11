/**
 * Extrai JWT (?t=) ou checkout code (?code=) de URLs Claro/Eldorado/Bemobi.
 */
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function parseLink(input) {
  const raw = input.trim();

  if (JWT_RE.test(raw)) {
    return { kind: 'jwt', jwt: raw };
  }

  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error('Link inválido. Use URL com ?t=JWT ou JWT puro.');
  }

  const jwt = url.searchParams.get('t');
  if (jwt) return { kind: 'jwt', jwt };

  const code = url.searchParams.get('code');
  if (code) return { kind: 'checkout', checkoutCode: code };

  throw new Error('URL sem ?t= (JWT) nem ?code= (checkout).');
}
