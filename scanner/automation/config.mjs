const toInt = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: toInt(process.env.AUTOMATION_PORT ?? process.env.PORT, 3000),
  headless: String(process.env.HEADLESS ?? 'false').toLowerCase() === 'true',
  defaultBrowser: (process.env.BROWSER_NAME || process.env.DEFAULT_BROWSER || 'edge')
    .trim()
    .toLowerCase(),
  pagamentoErroUrl:
    process.env.PAGAMENTO_ERRO_URL ??
    'https://clarorecarga.claro.com.br/whatsapp/pagamento-erro',
  pagamentoSucessoUrl:
    process.env.PAGAMENTO_SUCESSO_URL ??
    'https://clarorecarga.claro.com.br/whatsapp/pagamento-sucesso',
  defaultCvv: process.env.DEFAULT_CVV ?? '0000',
  defaultCardholderMaxLen: toInt(process.env.DEFAULT_CARDHOLDER_MAX_LEN, 7),
  keepBrowserOpenSeconds: toInt(process.env.KEEP_BROWSER_OPEN_SECONDS, 5),
  maxConcurrentSessions: toInt(process.env.MAX_CONCURRENT_SESSIONS, 3),
  sessionSlotWaitMs: toInt(process.env.SESSION_SLOT_WAIT_MS, 600000),
  actionTimeoutMs: toInt(process.env.ACTION_TIMEOUT_MS, 20000),
  cardIframeTimeoutMs: toInt(process.env.CARD_IFRAME_TIMEOUT_MS, 45000),
  cardFormReadyTimeoutMs: toInt(process.env.CARD_FORM_READY_TIMEOUT_MS, 18000),
  cardFormSettleMs: toInt(process.env.CARD_FORM_SETTLE_MS, 700),
  elementClickTimeoutMs: toInt(process.env.ELEMENT_CLICK_TIMEOUT_MS, 20000),
  pamTypingDelayMs: toInt(process.env.PAM_TYPING_DELAY_MS, 80),
  mobileViewportWidth: toInt(process.env.MOBILE_VIEWPORT_WIDTH, 390),
  mobileViewportHeight: toInt(process.env.MOBILE_VIEWPORT_HEIGHT, 844),
  browserWindowWidth: toInt(process.env.BROWSER_WINDOW_WIDTH, 980),
  browserWindowHeight: toInt(process.env.BROWSER_WINDOW_HEIGHT, 980),
  stepDelayDefaultMs: toInt(process.env.STEP_DELAY_DEFAULT_MS, 700),
  /** Pausas curtas entre cliques/navegação (ms) — aumente no .env se PC lento. */
  pauseAfterNavMs: toInt(process.env.PAUSE_AFTER_NAV_MS, 600),
  pauseAfterClickMs: toInt(process.env.PAUSE_AFTER_CLICK_MS, 450),
  pauseAfterValueMs: toInt(process.env.PAUSE_AFTER_VALUE_MS, 700),
  pollIntervalMs: toInt(process.env.POLL_INTERVAL_MS, 250),
};

export const WEB_PORTAL = 'https://clarorecarga.claro.com.br/minhaclaro_web';
