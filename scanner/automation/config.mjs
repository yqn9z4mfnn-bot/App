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
  keepBrowserOpenSeconds: toInt(process.env.KEEP_BROWSER_OPEN_SECONDS, 0),
  /** Após 3DS: 0 = fecha Edge imediatamente (segundos). */
  keepBrowserOpen3dsSeconds: toInt(process.env.KEEP_BROWSER_OPEN_3DS_SECONDS, 0),
  /** Após API /3ds/challenge, aguarda tela do banco antes de sinalizar 3DS (ms). */
  threedsUiWaitMs: toInt(process.env.THREDS_UI_WAIT_MS, 12000),
  /** Tempo extra de gate-wait após detectar 3DS antes de desistir (ms). */
  threedsExtraWaitMs: toInt(process.env.THREEDS_EXTRA_WAIT_MS, 60000),
  /** Após 3DS frictionless, continua gate-wait buscando CONFIRMED. */
  threedsContinueGateWait:
    String(process.env.THREEDS_CONTINUE_GATE_WAIT ?? '1').toLowerCase() !== '0',
  maxConcurrentSessions: toInt(process.env.MAX_CONCURRENT_SESSIONS, 3),
  sessionSlotWaitMs: toInt(process.env.SESSION_SLOT_WAIT_MS, 600000),
  actionTimeoutMs: toInt(process.env.ACTION_TIMEOUT_MS, 20000),
  cardIframeTimeoutMs: toInt(process.env.CARD_IFRAME_TIMEOUT_MS, 45000),
  cardFormReadyTimeoutMs: toInt(process.env.CARD_FORM_READY_TIMEOUT_MS, 18000),
  cardFormSettleMs: toInt(process.env.CARD_FORM_SETTLE_MS, 450),
  elementClickTimeoutMs: toInt(process.env.ELEMENT_CLICK_TIMEOUT_MS, 20000),
  pamTypingDelayMs: toInt(process.env.PAM_TYPING_DELAY_MS, 35),
  mobileViewportWidth: toInt(process.env.MOBILE_VIEWPORT_WIDTH, 390),
  mobileViewportHeight: toInt(process.env.MOBILE_VIEWPORT_HEIGHT, 844),
  browserWindowWidth: toInt(process.env.BROWSER_WINDOW_WIDTH, 980),
  browserWindowHeight: toInt(process.env.BROWSER_WINDOW_HEIGHT, 980),
  stepDelayDefaultMs: toInt(process.env.STEP_DELAY_DEFAULT_MS, 700),
  /** Pausas curtas entre cliques/navegação (ms) — aumente no .env se PC lento. */
  pauseAfterNavMs: toInt(process.env.PAUSE_AFTER_NAV_MS, 400),
  pauseAfterClickMs: toInt(process.env.PAUSE_AFTER_CLICK_MS, 280),
  /** Após clicar no valor — checkout Eldorado demora; não encurtar demais. */
  pauseAfterValueMs: toInt(process.env.PAUSE_AFTER_VALUE_MS, 650),
  pollIntervalMs: toInt(process.env.POLL_INTERVAL_MS, 180),
  checkoutOpenTimeoutMs: toInt(process.env.CHECKOUT_OPEN_TIMEOUT_MS, 45000),
  /** Se 1, mata todas as sessões ao iniciar nova recarga (modo sequencial). Padrão 0 = até 3 em paralelo. */
  closeAllSessionsOnStart:
    String(process.env.CLOSE_ALL_SESSIONS_ON_START ?? '0').toLowerCase() === '1',
  /** Fecha sessão órfã/travada após este tempo (ms). 0 = desligado. */
  sessionMaxLifetimeMs: toInt(process.env.SESSION_MAX_LIFETIME_MS, 180000),
  /** Remove cartão da wallet Eldorado após cada recarga browser. */
  removeCardAfterRecharge:
    String(process.env.REMOVE_CARD_AFTER_RECHARGE ?? '1').toLowerCase() !== '0',
  /** Modo rápido checkout-link: menos sleeps, browser fecha em background. */
  checkoutLinkFast: String(process.env.CHECKOUT_LINK_FAST ?? '1').toLowerCase() !== '0',
  checkoutLinkPollMs: toInt(process.env.CHECKOUT_LINK_POLL_MS, 50),
  checkoutLinkCardSettleMs: toInt(process.env.CHECKOUT_LINK_CARD_SETTLE_MS, 60),
  checkoutLinkPanTimeoutMs: toInt(process.env.CHECKOUT_LINK_PAN_TIMEOUT_MS, 8000),
  checkoutLinkGatePollMs: toInt(process.env.CHECKOUT_LINK_GATE_POLL_MS, 80),
  /** Após clicar pagar: fecha Edge e espera SSE via HTTP. */
  checkoutLinkHttpGate: String(process.env.CHECKOUT_LINK_HTTP_GATE ?? '1').toLowerCase() !== '0',
  checkoutLinkPaymentIdWaitMs: toInt(process.env.CHECKOUT_LINK_PAYMENT_ID_WAIT_MS, 12000),
  /** Antifraude browser: digitação humana + wait fingerprint. */
  antifraudHumanFill: String(process.env.ANTIFRAUD_HUMAN_FILL ?? '1').toLowerCase() !== '0',
  antifraudWaitMs: toInt(process.env.ANTIFRAUD_WAIT_MS, 3500),
  antifraudSettleMs: toInt(process.env.ANTIFRAUD_SETTLE_MS, 280),
  antifraudFieldGapMs: toInt(process.env.ANTIFRAUD_FIELD_GAP_MS, 220),
  antifraudPrePayMotion: String(process.env.ANTIFRAUD_PRE_PAY_MOTION ?? '1').toLowerCase() !== '0',
};

export const WEB_PORTAL = 'https://clarorecarga.claro.com.br/minhaclaro_web';
