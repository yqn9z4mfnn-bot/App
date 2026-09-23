#!/bin/bash
# Mantém o bot Telegram vivo e registra cada saída/reinício.
set -u

XDG_DATA_HOME="${XDG_DATA_HOME:-/home/ubuntu/.local/share/cloud-bot-home}"
export XDG_DATA_HOME
DATA_DIR="$XDG_DATA_HOME/linkclaro-bot"
APP_DIR="/workspace/scanner"
LOG="$DATA_DIR/logs/telegram-bot.log"
SUPERVISOR_LOG="$DATA_DIR/logs/telegram-bot-supervisor.log"

mkdir -p "$DATA_DIR/logs"

child_pid=""
stop_supervisor() {
  printf '%s [supervisor] sinal recebido; encerrando child=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${child_pid:-none}" >> "$SUPERVISOR_LOG"
  [ -n "$child_pid" ] && kill -TERM "$child_pid" 2>/dev/null || true
  exit 0
}
trap stop_supervisor INT TERM HUP

while true; do
  printf '%s [supervisor] iniciando bot\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$SUPERVISOR_LOG"

  set -a
  # shellcheck disable=SC1090
  source "$DATA_DIR/.env"
  set +a
  export NUMBERS_DB="$DATA_DIR/numbers.db"
  export ADMIN_DB="$DATA_DIR/admin.db"

  cd "$APP_DIR"
  node telegram-bot.mjs >> "$LOG" 2>&1 &
  child_pid=$!
  wait "$child_pid"
  status=$?
  child_pid=""

  printf '%s [supervisor] bot saiu status=%s; reinício em 2s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$status" >> "$SUPERVISOR_LOG"
  sleep 2
done
