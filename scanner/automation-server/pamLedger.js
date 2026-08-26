/** Stubs — cartão vem do bot via pamInfo no POST /api/session/start-web-link */
export function normalizePamLine(line) {
  return String(line ?? '').trim();
}

export function claimSpecificPamFromInfo(_pam) {
  /* cartão já enviado pelo bot */
}

export function claimNextPamFromInfo() {
  return null;
}

export function returnPamToInfo(_pam) {}

export function finalizePamLedger(_session, _payload, _paymentResult, _runError) {
  return null;
}

export function readAttemptsTail(_limit) {
  return [];
}
