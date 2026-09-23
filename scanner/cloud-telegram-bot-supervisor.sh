#!/bin/bash
# Mantém o bot Telegram vivo e registra cada saída/reinício.
set -u

XDG_DATA_HOME="${XDG_DATA_HOME:-/home/ubuntu/.local/share/cloud-bot-home}"
export XDG_DATA_HOME
DATA_DIR="$XDG_DATA_HOME/linkclaro-bot"
APP_DIR="/workspace/scanner"
LOG="$DATA_DIR/logs/telegram-bot.log"
SUPERVISOR_LOG="$DATA_DIR/logs/telegram-bot-supervisor.log"
HEARTBEAT="$DATA_DIR/bot-heartbeat.json"
HEARTBEAT_STALE_SEC="${BOT_HEARTBEAT_STALE_SEC:-180}"

mkdir -p "$DATA_DIR/logs"

child_pid=""
watchdog_pid=""
stop_supervisor() {
  printf '%s [supervisor] sinal recebido; encerrando child=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${child_pid:-none}" >> "$SUPERVISOR_LOG"
  [ -n "$watchdog_pid" ] && kill "$watchdog_pid" 2>/dev/null || true
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

  # Um processo Node pode continuar listado enquanto o long polling fica
  # travado. Nesse caso wait nunca retorna; o watchdog força a saída para o
  # loop relançar o bot.
  (
    sleep "$HEARTBEAT_STALE_SEC"
    while kill -0 "$child_pid" 2>/dev/null; do
      stale_sec="$(
        python3 - "$HEARTBEAT" "$child_pid" <<'PY' 2>/dev/null || echo 999999
import json, os, sys, time
path, expected_pid = sys.argv[1], int(sys.argv[2])
try:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if int(data.get("pid") or 0) != expected_pid:
        print(999999)
    else:
        print(max(0, int(time.time() - int(data.get("at") or 0) / 1000)))
except Exception:
    print(999999)
PY
      )"
      if [ "$stale_sec" -ge "$HEARTBEAT_STALE_SEC" ] 2>/dev/null; then
        printf '%s [supervisor] heartbeat travado %ss pid=%s; enviando TERM\n' \
          "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$stale_sec" "$child_pid" >> "$SUPERVISOR_LOG"
        kill -TERM "$child_pid" 2>/dev/null || true
        sleep 5
        if kill -0 "$child_pid" 2>/dev/null; then
          printf '%s [supervisor] pid=%s não encerrou; enviando KILL\n' \
            "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$child_pid" >> "$SUPERVISOR_LOG"
          kill -KILL "$child_pid" 2>/dev/null || true
        fi
        exit 0
      fi
      sleep 30
    done
  ) &
  watchdog_pid=$!

  wait "$child_pid"
  status=$?
  child_pid=""
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  watchdog_pid=""

  printf '%s [supervisor] bot saiu status=%s; reinício em 2s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$status" >> "$SUPERVISOR_LOG"
  sleep 2
done
