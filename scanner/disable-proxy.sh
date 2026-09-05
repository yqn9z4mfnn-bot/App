#!/bin/bash
# Desliga Smartproxy no .env do appdata (padrão aprovado).
set -euo pipefail

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/linkclaro-bot"
ENV_FILE="$DATA_DIR/.env"

mkdir -p "$DATA_DIR"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

set_var() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

set_var PROXY_ENABLED 0
set_var PROXY_PAYMENT_ONLY 0
set_var PROXY_ROTATE 0

echo "Proxy DESLIGADO em $ENV_FILE (PROXY_ENABLED=0)"
echo "Reinicie os serviços do ambiente (cloud-start-services.sh ou vps-start-services.sh)."
