const CLARO_API = 'https://claro-recarga-api.m4u.com.br';
const CHANNEL = 'MINHA_CLARO_WEB';

export async function request(url, options = {}) {
  const started = Date.now();
  const res = await fetch(url, {
    ...options,
    headers: {
      channel: CHANNEL,
      accept: 'application/json',
      ...options.headers,
    },
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return {
    ok: res.ok,
    status: res.status,
    body,
    latencyMs: Date.now() - started,
  };
}

export function claroHeaders(sessionId) {
  const headers = {
    channel: CHANNEL,
    'content-type': 'application/json',
  };
  if (sessionId) {
    headers.authorization = `claro ${sessionId}`;
  }
  return headers;
}

export async function claroGet(path, sessionId) {
  return request(`${CLARO_API}${path}`, { headers: claroHeaders(sessionId) });
}

export async function claroPost(path, sessionId, payload) {
  return request(`${CLARO_API}${path}`, {
    method: 'POST',
    headers: claroHeaders(sessionId),
    body: JSON.stringify(payload),
  });
}

export { CLARO_API, CHANNEL };
