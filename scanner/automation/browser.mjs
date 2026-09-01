import { platform } from 'node:os';
import { chromium, firefox, devices } from 'playwright';
import { config } from './config.mjs';
import { describeProxy, getPlaywrightProxy, proxyEnabled, proxyPaymentOnly } from '../lib/proxy.mjs';

/** Linux: channel msedge abre o Edge nativo do SO; padrão = Chromium empacotado do Playwright. */
const useNativeEdgeChannel = () =>
  String(process.env.BROWSER_USE_NATIVE_EDGE ?? '0').toLowerCase() === '1';

const shouldUseBundledChromiumForEdge = () =>
  platform() === 'linux' && !useNativeEdgeChannel();

export const normalizeBrowserName = (raw) => {
  const name = String(raw ?? config.defaultBrowser).trim().toLowerCase();
  if (['edge', 'msedge', 'microsoft-edge'].includes(name)) return 'edge';
  if (['chrome', 'google-chrome'].includes(name)) return 'chrome';
  if (name === 'firefox') return 'firefox';
  if (name === 'chromium') return 'chromium';
  return config.defaultBrowser === 'edge' ? 'edge' : name;
};

export const resolveBrowserName = (payload) =>
  normalizeBrowserName(payload?.browser ?? payload?.browserName ?? config.defaultBrowser);

export const isBrowserLockedByEnv = () =>
  Boolean(String(process.env.BROWSER_NAME || process.env.DEFAULT_BROWSER || '').trim());

/** Abre Edge/Chrome/Firefox conforme padrão da automação de referência. */
export const launchBrowser = async (browserName) => {
  const name = normalizeBrowserName(browserName);
  const headless = config.headless === true;
  const proxy = getPlaywrightProxy();
  const launchOpts = {
    headless,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      `--window-size=${config.browserWindowWidth},${config.browserWindowHeight}`,
      '--window-position=80,40',
      '--disable-blink-features=AutomationControlled',
      // HTTP/3 (QUIC) fura proxy HTTP e vaza o IP da VPS para a gate.
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--enforce-webrtc-ip-permission-check',
    ],
  };
  if (proxy) launchOpts.proxy = proxy;
  else if (proxyEnabled()) {
    console.warn('[automation] PROXY_ENABLED=1 mas dados do proxy incompletos — Edge sai pelo IP da VPS');
  }

  const launchKind =
    name === 'edge' && shouldUseBundledChromiumForEdge()
      ? 'chromium (Playwright bundled — evita Edge nativo no Linux)'
      : name;

  console.log(
    `[automation] launch browser=${launchKind} headless=${headless} proxy=${describeProxy() || (proxyPaymentOnly() ? 'OFF até checkout' : 'OFF (IP da VPS)')}`,
  );

  if (name === 'chrome') {
    return chromium.launch({ ...launchOpts, channel: 'chrome' });
  }
  if (name === 'edge') {
    if (shouldUseBundledChromiumForEdge()) {
      return chromium.launch(launchOpts);
    }
    return chromium.launch({ ...launchOpts, channel: 'msedge' });
  }
  if (name === 'firefox') {
    return firefox.launch({
      headless,
      ...(proxy ? { proxy } : {}),
    });
  }
  return chromium.launch(launchOpts);
};

export const createMobileContext = async (browser) => {
  const proxy = getPlaywrightProxy();
  return browser.newContext({
    ...devices['iPhone 12'],
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    geolocation: { latitude: -23.5505, longitude: -46.6333 },
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    viewport: {
      width: config.mobileViewportWidth,
      height: config.mobileViewportHeight,
    },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    ...(proxy ? { proxy } : {}),
  });
};
