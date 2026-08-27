import { chromium, firefox, devices } from 'playwright';
import { config } from './config.mjs';

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
  const launchOpts = {
    headless,
    args: [
      `--window-size=${config.browserWindowWidth},${config.browserWindowHeight}`,
      '--window-position=80,40',
    ],
  };
  console.log(`[automation] launch browser=${name} headless=${headless}`);

  if (name === 'chrome') {
    return chromium.launch({ ...launchOpts, channel: 'chrome' });
  }
  if (name === 'edge') {
    return chromium.launch({ ...launchOpts, channel: 'msedge' });
  }
  if (name === 'firefox') {
    return firefox.launch({ headless });
  }
  return chromium.launch(launchOpts);
};

export const createMobileContext = async (browser) =>
  browser.newContext({
    ...devices['iPhone 12'],
    viewport: {
      width: config.mobileViewportWidth,
      height: config.mobileViewportHeight,
    },
  });
