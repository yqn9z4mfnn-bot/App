#!/bin/bash
# Ativa Smartproxy no .env do appdata (sem commitar credenciais).
set -euo pipefail

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/linkclaro-bot"
ENV_FILE="$DATA_DIR/.env"

for v in PROXY_SERVER PROXY_PORT PROXY_USERNAME PROXY_PASSWORD; do
  if [ -z "${!v:-}" ]; then
    echo "Defina: $v=... (ex.: export $v=...)"
    exit 1
  fi
done

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

set_var PROXY_ENABLED 1
set_var PROXY_SERVER "$PROXY_SERVER"
set_var PROXY_PORT "$PROXY_PORT"
set_var PROXY_USERNAME "$PROXY_USERNAME"
set_var PROXY_PASSWORD "$PROXY_PASSWORD"
set_var CLARO_LINK_TIMEOUT_MS "${CLARO_LINK_TIMEOUT_MS:-15000}"
set_var PROXY_CONNECT_TIMEOUT_MS "${PROXY_CONNECT_TIMEOUT_MS:-10000}"

echo "Proxy configurado em $ENV_FILE ($(grep PROXY_SERVER "$ENV_FILE" | cut -d= -f2):$(grep PROXY_PORT "$ENV_FILE" | cut -d= -f2))"
echo "Reinicie: bash $DATA_DIR/stop.sh && bash $DATA_DIR/run.sh"
