#!/bin/bash
# Nuvem Cursor: automação + bot + admin (tmux)
set -euo pipefail
export XDG_DATA_HOME="${XDG_DATA_HOME:-/home/ubuntu/.local/share/cloud-bot-home}"
DATA_DIR="$XDG_DATA_HOME/linkclaro-bot"
APP_DIR="/workspace/scanner"
TMUX="tmux -f /exec-daemon/tmux.portal.conf"
mkdir -p "$DATA_DIR/logs"

run_in_tmux() {
  local name="$1"
  local cmd="$2"
  local pgrep_pattern="$3"
  if pgrep -f "$pgrep_pattern" >/dev/null 2>&1; then
    echo "[$name] já rodando (pid ok) — não reinicia"
    return 0
  fi
  if $TMUX has-session -t "=$name" 2>/dev/null; then
    $TMUX send-keys -t "$name:0.0" C-c
    sleep 1
    $TMUX send-keys -t "$name:0.0" "$cmd" C-m
  else
    $TMUX new-session -d -s "$name" -c "$APP_DIR" -- bash -lc "$cmd"
  fi
}

ENV_EXPORT="export XDG_DATA_HOME=$XDG_DATA_HOME; set -a; source $DATA_DIR/.env; set +a; export XDG_DATA_HOME=$XDG_DATA_HOME; export NUMBERS_DB=$DATA_DIR/numbers.db; export ADMIN_DB=$DATA_DIR/admin.db; cd $APP_DIR"

run_in_tmux cloud-automation "$ENV_EXPORT; node automation/run.mjs" "node automation/run.mjs"
run_in_tmux cloud-telegram-bot "$ENV_EXPORT; node telegram-bot.mjs 2>&1 | tee -a $DATA_DIR/logs/telegram-bot.log" "node telegram-bot.mjs"
run_in_tmux cloud-admin "$ENV_EXPORT; node admin/run.mjs" "node admin/run.mjs"
bash "$APP_DIR/telegram-user/cloud-start-facil-worker.sh" 2>/dev/null || true

echo "Automação: tmux attach -t cloud-automation"
echo "Bot:       tmux attach -t cloud-telegram-bot"
echo "Admin:     tmux attach -t cloud-admin  (http://127.0.0.1:\${ADMIN_PORT:-3080})"
echo "Worker:    tmux attach -t cloud-facil-worker"
