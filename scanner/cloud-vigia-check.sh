#!/bin/bash
# Vigia nuvem: status dos serviços (sem alterar .env/proxy).
set -euo pipefail
export XDG_DATA_HOME="${XDG_DATA_HOME:-/home/ubuntu/.local/share/cloud-bot-home}"
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

bot_poll_stale_ms() {
  local hb="$DATA_DIR/bot-heartbeat.json"
  [ -f "$hb" ] || return 0
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

ensure_bot_alive() {
  local pattern="node telegram-bot.mjs"
  local stale_ms
  stale_ms="$(bot_poll_stale_ms)"
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    # getUpdates long-poll ~90s; margem 3 min sem heartbeat = loop travado
    if [ "$stale_ms" -gt 180000 ] 2>/dev/null; then
      echo "(Bot Telegram TRAVADO — heartbeat ${stale_ms}ms — reiniciando…)"
      pkill -f "$pattern" 2>/dev/null || true
      sleep 2
    else
      return 0
    fi
  fi
  ensure_node_service "Bot Telegram" "$pattern" cloud-telegram-bot "node telegram-bot.mjs" "telegram-bot.log"
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

echo "=== cloud-vigia $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo "--- tmux ---"
$TMUX ls 2>/dev/null || echo "(sem sessões tmux)"
echo "--- processos ---"

ensure_bot_alive
ensure_node_service "Automação" "node automation/run.mjs" cloud-automation "node automation/run.mjs" "automation.log"
ensure_node_service "Admin" "node admin/run.mjs" cloud-admin "node admin/run.mjs" "admin.log"

pgrep -af "node (telegram-bot|automation/run|admin/run)" 2>/dev/null || echo "(node bot/auto/admin ausentes)"

if pgrep -f "facil_auto_worker.py" >/dev/null 2>&1; then
  pgrep -af "facil_auto_worker.py"
else
  echo "(worker Fácil PARADO — reiniciando…)"
  bash /workspace/scanner/telegram-user/cloud-start-facil-worker.sh
  sleep 3
  pgrep -af "facil_auto_worker.py" 2>/dev/null || echo "(worker ainda ausente após restart)"
fi
echo "--- health ---"
curl -sf http://127.0.0.1:3000/health 2>/dev/null || echo "automation: FALHOU"
curl -sf -o /dev/null -w "admin HTTP %{http_code}\n" http://127.0.0.1:3080/ 2>/dev/null || echo "admin: FALHOU"
echo "--- proxy ---"
grep -E '^PROXY_ENABLED=' "$DATA_DIR/.env" 2>/dev/null || true
