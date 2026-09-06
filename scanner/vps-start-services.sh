#!/bin/bash
# VPS: automação + bot + admin (tmux + Xvfb)
set -euo pipefail
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
DATA_DIR="$XDG_DATA_HOME/linkclaro-bot"
APP_DIR="${APP_DIR:-$HOME/App/scanner}"
TMUX="${TMUX_CMD:-tmux -S /tmp/tmux-0/default}"

if [ ! -d "$APP_DIR" ]; then
  echo "APP_DIR não encontrado: $APP_DIR" >&2
  exit 1
fi

if ! pgrep -f 'Xvfb :1' >/dev/null 2>&1; then
  Xvfb :1 -screen 0 1280x720x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  sleep 1
fi
export DISPLAY="${DISPLAY:-:1}"

ENV_EXPORT="export XDG_DATA_HOME=$XDG_DATA_HOME; export DISPLAY=$DISPLAY; set -a; source $DATA_DIR/.env; set +a; export NUMBERS_DB=$DATA_DIR/numbers.db; export ADMIN_DB=$DATA_DIR/admin.db; cd $APP_DIR"

start_session() {
  local name="$1"
  local cmd="$2"
  $TMUX kill-session -t "$name" 2>/dev/null || true
  $TMUX new-session -d -s "$name" -c "$APP_DIR" -- bash -lc "$cmd"
}

start_session vps-automation "$ENV_EXPORT; node automation/run.mjs"
start_session vps-telegram-bot "$ENV_EXPORT; node telegram-bot.mjs"
start_session vps-admin "$ENV_EXPORT; node admin/run.mjs"

echo "Automação: tmux attach -t vps-automation"
echo "Bot:       tmux attach -t vps-telegram-bot"
echo "Admin:     tmux attach -t vps-admin  (http://127.0.0.1:\${ADMIN_PORT:-3080})"
