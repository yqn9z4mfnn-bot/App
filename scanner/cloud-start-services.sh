#!/bin/bash
# Nuvem Cursor: automação + bot + admin (tmux)
set -euo pipefail
export XDG_DATA_HOME="${XDG_DATA_HOME:-/home/ubuntu/.local/share/cloud-bot-home}"
DATA_DIR="$XDG_DATA_HOME/linkclaro-bot"
APP_DIR="/workspace/scanner"
TMUX="tmux -f /exec-daemon/tmux.portal.conf"

run_in_tmux() {
  local name="$1"
  local cmd="$2"
  if $TMUX has-session -t "=$name" 2>/dev/null; then
    $TMUX send-keys -t "$name:0.0" C-c
    sleep 1
    $TMUX send-keys -t "$name:0.0" "$cmd" C-m
  else
    $TMUX new-session -d -s "$name" -c "$APP_DIR" -- bash -lc "$cmd"
  fi
}

ENV_EXPORT="export XDG_DATA_HOME=$XDG_DATA_HOME; set -a; source $DATA_DIR/.env; set +a; export NUMBERS_DB=$DATA_DIR/numbers.db; export ADMIN_DB=$DATA_DIR/admin.db; cd $APP_DIR"

run_in_tmux cloud-automation "$ENV_EXPORT; node automation/run.mjs"
run_in_tmux cloud-telegram-bot "$ENV_EXPORT; node telegram-bot.mjs"
run_in_tmux cloud-admin "$ENV_EXPORT; node admin/run.mjs"

echo "Automação: tmux attach -t cloud-automation"
echo "Bot:       tmux attach -t cloud-telegram-bot"
echo "Admin:     tmux attach -t cloud-admin  (http://127.0.0.1:\${ADMIN_PORT:-3080})"
