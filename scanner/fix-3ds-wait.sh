#!/bin/bash
# Corrige .env da VPS se ainda tiver espera frictionless no 3DS (88s).
set -euo pipefail
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/linkclaro-bot"
ENV_FILE="$DATA_DIR/.env"
touch "$ENV_FILE"

set_var() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

set_var THREEDS_CONTINUE_GATE_WAIT 0
set_var THREEDS_UI_WAIT_MS 0
set_var THREEDS_EXTRA_WAIT_MS 0

echo "3DS wait desligado em $ENV_FILE"
echo "Reinicie: bash $DATA_DIR/stop.sh && bash $DATA_DIR/run.sh"
