#!/bin/bash
# Ajusta 3DS frictionless curto (8s VBV + 12s CONFIRMED — não 88s).
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

set_var THREEDS_CONTINUE_GATE_WAIT 1
set_var THREEDS_UI_WAIT_MS 8000
set_var THREEDS_EXTRA_WAIT_MS 12000

echo "3DS frictionless curto em $ENV_FILE (8s UI + 12s CONFIRMED)"
echo "Reinicie: bash $DATA_DIR/stop.sh && bash $DATA_DIR/run.sh"
