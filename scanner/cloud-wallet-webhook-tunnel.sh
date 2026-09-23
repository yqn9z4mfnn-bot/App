#!/bin/bash
# Túnel HTTPS público (cloudflared quick) → admin :3080 para webhooks PushinPay.
set -euo pipefail
export XDG_DATA_HOME="${XDG_DATA_HOME:-/home/ubuntu/.local/share/cloud-bot-home}"
DATA_DIR="$XDG_DATA_HOME/linkclaro-bot"
LOG="${CLOUDFLARED_WALLET_LOG:-/tmp/cloudflared-wallet.log}"
URL_FILE="$DATA_DIR/wallet-webhook-public-url.txt"
mkdir -p "$DATA_DIR"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared não instalado" >&2
  exit 1
fi

: >"$LOG"
echo "[wallet-tunnel] iniciando cloudflared → http://127.0.0.1:3080 (log: $LOG)"

cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:3080" 2>&1 | tee -a "$LOG" | while IFS= read -r line; do
  if [[ "$line" =~ https://[a-z0-9-]+\.trycloudflare\.com ]]; then
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' <<<"$line" | head -1)"
    if [ -n "$url" ] && [ "$(cat "$URL_FILE" 2>/dev/null || true)" != "$url" ]; then
      printf '%s\n' "$url" >"$URL_FILE"
      echo "[wallet-tunnel] URL pública gravada em $URL_FILE"
    fi
  fi
done
