import { proxyLink, proxyAllTraffic, shouldProxyHttp, describeProxy } from '../lib/proxy.mjs';

function setEnv(map) {
  for (const [k, v] of Object.entries(map)) {
    if (v == null) delete process.env[k];
    else process.env[k] = String(v);
  }
}

const CLARO = 'https://claro-recarga-api.m4u.com.br/sessions/';
const LINK = 'https://dayanes2lucas.ngrok.dev/claro/link/11991000000';
const PAY = 'https://smart-checkout.bemobi.com/api-bsc/api/v1/payments';

setEnv({
  PROXY_ENABLED: '1',
  PROXY_PAYMENT_ONLY: '0',
  PROXY_LINK: '0',
  PROXY_SERVER: 'proxy.smartproxy.net',
  PROXY_PORT: '3120',
  PROXY_USERNAME: 'u',
  PROXY_PASSWORD: 'p',
});

if (proxyAllTraffic() !== true) throw new Error('API geral deveria usar proxy');
if (proxyLink() !== false) throw new Error('PROXY_LINK=0 deveria desligar proxy do link');
if (shouldProxyHttp(LINK, { useProxy: proxyLink() }) !== false) {
  throw new Error('link não pode ir pelo proxy');
}
if (shouldProxyHttp(CLARO) !== true) throw new Error('API Claro precisa de proxy');
if (shouldProxyHttp(PAY) !== true) throw new Error('pagamento precisa de proxy');
if (!String(describeProxy() || '').includes('link-direct')) {
  throw new Error(`describeProxy deveria marcar link-direct: ${describeProxy()}`);
}

setEnv({ PROXY_LINK: null, PROXY_PAYMENT_ONLY: '1' });
if (proxyLink() !== false) throw new Error('payment-only: link off');
if (shouldProxyHttp(CLARO) !== false) throw new Error('payment-only: API Claro off');
if (shouldProxyHttp(PAY) !== true) throw new Error('payment-only: pagamento on');

console.log('ok proxy-link-scope');
