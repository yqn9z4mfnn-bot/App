#!/bin/bash
# Vigia nuvem: status dos serviços (sem alterar .env/proxy).
set -euo pipefail
XDG_DATA_HOME="/home/ubuntu/.local/share/cloud-bot-home"
export XDG_DATA_HOME
DATA_DIR="$XDG_DATA_HOME/linkclaro-bot"
APP_DIR="/workspace/scanner"
TMUX="tmux -f /exec-daemon/tmux.portal.conf"

ENV_EXPORT="export XDG_DATA_HOME=$XDG_DATA_HOME; set -a; source $DATA_DIR/.env; set +a; export XDG_DATA_HOME=$XDG_DATA_HOME; export NUMBERS_DB=$DATA_DIR/numbers.db; export ADMIN_DB=$DATA_DIR/admin.db; cd $APP_DIR"

mkdir -p "$DATA_DIR/logs"

start_tmux_node() {
  local session="$1"
  local node_cmd="$2"
  local log_name="$3"
  local full_cmd="$ENV_EXPORT; $node_cmd"
  if [ -n "$log_name" ]; then
    full_cmd="$full_cmd 2>&1 | tee -a $DATA_DIR/logs/$log_name"
  fi
  if $TMUX has-session -t "=$session" 2>/dev/null; then
    $TMUX send-keys -t "$session:0.0" C-c
    sleep 1
    $TMUX send-keys -t "$session:0.0" "$full_cmd" C-m
  else
    $TMUX new-session -d -s "$session" -c "$APP_DIR" -- bash -lc "$full_cmd"
  fi
}

BOT_HEARTBEAT_STALE_MS="${BOT_HEARTBEAT_STALE_MS:-180000}"
BOT_LOG_STALE_MS="${BOT_LOG_STALE_MS:-240000}"

bot_poll_stale_ms() {
  local hb="$DATA_DIR/bot-heartbeat.json"
  if [ ! -f "$hb" ]; then
    echo 999999999
    return
  fi
  python3 - "$hb" <<'PY' 2>/dev/null || echo 999999999
import json, sys, time
path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    print(int(time.time() * 1000 - int(data.get("at") or 0)))
except Exception:
    print(999999999)
PY
}

bot_log_stale_ms() {
  local log="$DATA_DIR/logs/telegram-bot.log"
  if [ ! -f "$log" ]; then
    echo 999999999
    return
  fi
  python3 - "$log" <<'PY' 2>/dev/null || echo 999999999
import os, sys, time
try:
    print(int(time.time() * 1000 - int(os.path.getmtime(sys.argv[1]) * 1000)))
except Exception:
    print(999999999)
PY
}

ensure_bot_alive() {
  local pattern="node telegram-bot.mjs"
  local session="cloud-telegram-bot"
  local supervisor="$APP_DIR/cloud-telegram-bot-supervisor.sh"
  local stale_ms log_stale_ms reason=""
  local running=0 tmux_ok=0

  [ -x "$supervisor" ] || chmod +x "$supervisor" 2>/dev/null || true
  stale_ms="$(bot_poll_stale_ms)"
  log_stale_ms="$(bot_log_stale_ms)"
  pgrep -f "$pattern" >/dev/null 2>&1 && running=1
  $TMUX has-session -t "=$session" 2>/dev/null && tmux_ok=1

  if [ "$running" -eq 1 ] && [ "$tmux_ok" -eq 1 ]; then
    if [ -f "$DATA_DIR/bot-heartbeat.json" ] && [ "$stale_ms" -gt "$BOT_HEARTBEAT_STALE_MS" ] 2>/dev/null; then
      reason="heartbeat parado há ${stale_ms}ms"
    elif [ "$log_stale_ms" -gt "$BOT_LOG_STALE_MS" ] 2>/dev/null; then
      reason="log telegram-bot.log sem escrita há ${log_stale_ms}ms"
    else
      return 0
    fi
  elif [ "$running" -eq 1 ] && [ "$tmux_ok" -eq 0 ]; then
    reason="processo órfão (tmux $session ausente)"
  elif [ "$running" -eq 0 ]; then
    reason="processo ausente"
  fi

  if [ -n "$reason" ]; then
    echo "(Bot Telegram — $reason — reiniciando…)"
    $TMUX kill-session -t "$session" 2>/dev/null || true
    pkill -f "$pattern" 2>/dev/null || true
    sleep 2
  fi

  if ! pgrep -f "$pattern" >/dev/null 2>&1 || ! $TMUX has-session -t "=$session" 2>/dev/null; then
    echo "(Bot Telegram PARADO — iniciando supervisor…)"
    $TMUX new-session -d -s "$session" -c "$APP_DIR" -- bash -lc "exec '$supervisor'"
    sleep 3
    pgrep -af "$pattern" 2>/dev/null || echo "(Bot Telegram ainda ausente após supervisor)"
  fi
}

ensure_vigia_daemon() {
  if command -v crontab >/dev/null 2>&1; then
    return
  fi
  local session="cloud-vigia-daemon"
  local daemon="$APP_DIR/cloud-vigia-daemon.sh"
  [ -x "$daemon" ] || chmod +x "$daemon" 2>/dev/null || true
  if $TMUX has-session -t "=$session" 2>/dev/null; then
    return
  fi
  echo "(Daemon vigia PARADO — reiniciando tmux $session…)"
  $TMUX new-session -d -s "$session" -c "$APP_DIR" -- bash -lc "exec '$daemon'"
}

ensure_wallet_webhook_tunnel() {
  local session="cloudflared-wallet-webhook"
  local script="$APP_DIR/cloud-wallet-webhook-tunnel.sh"
  [ -x "$script" ] || chmod +x "$script"
  if $TMUX has-session -t "=$session" 2>/dev/null; then
    return
  fi
  echo "(Túnel webhook PIX PARADO — reiniciando cloudflared…)"
  $TMUX new-session -d -s "$session" -c "$APP_DIR" -- bash -lc "export XDG_DATA_HOME=$XDG_DATA_HOME; exec '$script'"
  sleep 4
}

ensure_node_service() {
  local label="$1"
  local pgrep_pattern="$2"
  local session="$3"
  local node_cmd="$4"
  local log_name="${5:-}"

  if pgrep -f "$pgrep_pattern" >/dev/null 2>&1; then
    return
  fi

  echo "($label PARADO — reiniciando…)"
  start_tmux_node "$session" "$node_cmd" "$log_name"
  sleep 3
  if pgrep -f "$pgrep_pattern" >/dev/null 2>&1; then
    pgrep -af "$pgrep_pattern" || true
  else
    echo "($label ainda ausente após restart)"
  fi
}

start_facil_worker() {
  local DIR="$APP_DIR/telegram-user"
  local TU="${TELEGRAM_USER_DATA:-$XDG_DATA_HOME/telegram-user}"
  local VENV="$DIR/.venv/bin/python3"
  local PIP="$DIR/.venv/bin/pip"
  local PY="python3"
  if [ -x "$VENV" ]; then
    PY="$VENV"
    if ! "$VENV" -c "import telethon" 2>/dev/null; then
      [ -x "$PIP" ] && "$PIP" install -q -r "$DIR/requirements.txt" || true
    fi
  fi
  $TMUX kill-session -t cloud-facil-worker 2>/dev/null || true
  pkill -f "facil_auto_worker.py" 2>/dev/null || true
  sleep 1
  rm -f "$TU/facil-auto-worker.lock" 2>/dev/null || true
  $TMUX new-session -d -s cloud-facil-worker -c "$DIR" -- bash -lc "
    set -a; source '$DIR/.env'; source '$DATA_DIR/.env'; set +a
    export TELEGRAM_USER_DATA='$TU'
    export TELEGRAM_PROXY_ENABLED=\${TELEGRAM_PROXY_ENABLED:-1}
    export TELEGRAM_PROXY_TYPE=\${TELEGRAM_PROXY_TYPE:-socks5}
    export TELEGRAM_PROXY_SERVER=\${TELEGRAM_PROXY_SERVER:-\${PROXY_SERVER:-}}
    export TELEGRAM_PROXY_PORT=\${TELEGRAM_PROXY_PORT:-\${PROXY_PORT:-}}
    export TELEGRAM_PROXY_USERNAME=\${TELEGRAM_PROXY_USERNAME:-\${PROXY_USERNAME:-}}
    export TELEGRAM_PROXY_PASSWORD=\${TELEGRAM_PROXY_PASSWORD:-\${PROXY_PASSWORD:-}}
    cd '$DIR'
    exec '$PY' -u facil_auto_worker.py --loop 2>&1 | tee -a '$DATA_DIR/logs/facil-worker.log'
  "
}

echo "=== cloud-vigia $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo "--- tmux ---"
$TMUX ls 2>/dev/null || echo "(sem sessões tmux)"
echo "--- processos ---"

ensure_bot_alive
ensure_vigia_daemon

if ! curl -sf http://127.0.0.1:3000/health 2>/dev/null | grep -q '"aliveSessions"'; then
  :
else
  alive="$(curl -sf http://127.0.0.1:3000/health | python3 -c "import sys,json; print(json.load(sys.stdin).get('aliveSessions',0))" 2>/dev/null || echo 0)"
  if [ "${alive:-0}" -gt 0 ] 2>/dev/null; then
    echo "(Automação com aliveSessions=$alive — não reinicia automação)"
  else
    ensure_node_service "Automação" "node automation/run.mjs" cloud-automation "node automation/run.mjs" "automation.log"
  fi
fi
if ! pgrep -f "node admin/run.mjs" >/dev/null 2>&1 || ! curl -sf -o /dev/null --max-time 3 http://127.0.0.1:3080/ 2>/dev/null; then
  $TMUX kill-session -t cloud-admin 2>/dev/null || true
  ensure_node_service "Admin" "node admin/run.mjs" cloud-admin "node admin/run.mjs" "admin.log"
fi
ensure_wallet_webhook_tunnel

pgrep -af "node (telegram-bot|automation/run|admin/run)" 2>/dev/null || echo "(node bot/auto/admin ausentes)"

FACIL_PAUSE="${XDG_DATA_HOME:-/home/ubuntu/.local/share/cloud-bot-home}/linkclaro-bot/facil-worker.paused"
if pgrep -f "facil_auto_worker.py" >/dev/null 2>&1; then
  pgrep -af "facil_auto_worker.py"
elif [ -f "$FACIL_PAUSE" ]; then
  echo "(worker Fácil PAUSADO manualmente — vigia não reinicia; rm $FACIL_PAUSE ou cloud-start-facil-worker.sh)"
else
  echo "(worker Fácil PARADO — reiniciando…)"
  start_facil_worker
  sleep 3
  pgrep -af "facil_auto_worker.py" 2>/dev/null || echo "(worker ainda ausente após restart)"
fi
echo "--- health ---"
curl -sf http://127.0.0.1:3000/health 2>/dev/null || echo "automation: FALHOU"
curl -sf -o /dev/null -w "admin HTTP %{http_code}\n" http://127.0.0.1:3080/ 2>/dev/null || echo "admin: FALHOU"
if [ -f "$DATA_DIR/wallet-webhook-public-url.txt" ]; then
  echo "webhook público: $(tr -d '\n' <"$DATA_DIR/wallet-webhook-public-url.txt")"
else
  echo "webhook público: (arquivo wallet-webhook-public-url.txt ausente)"
fi
echo "--- proxy ---"
grep -E '^PROXY_ENABLED=' "$DATA_DIR/.env" 2>/dev/null || true
