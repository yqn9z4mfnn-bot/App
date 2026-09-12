#!/bin/bash
# Nuvem Cursor: worker Fácil (Telethon user) → bot Linkclaro
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TMUX="tmux -f /exec-daemon/tmux.portal.conf"
VENV="$DIR/.venv/bin/python3"
DATA="${TELEGRAM_USER_DATA:-/home/ubuntu/.local/share/cloud-bot-home/telegram-user}"

if [ ! -x "$VENV" ]; then
  echo "Instalando venv…"
  bash "$DIR/vps-install-telegram-user.sh"
fi

mkdir -p "$DATA"
chmod 700 "$DATA"
rm -f "$DATA/facil-auto-worker.lock"

$TMUX kill-session -t cloud-facil-worker 2>/dev/null || true
pkill -f "facil_auto_worker.py" 2>/dev/null || true
sleep 1

BOT_ENV="${XDG_DATA_HOME:-/home/ubuntu/.local/share/cloud-bot-home}/linkclaro-bot/.env"
$TMUX new-session -d -s cloud-facil-worker -c "$DIR" -- bash -lc "
  set -a; source '$DIR/.env'; set +a
  [ -f '$BOT_ENV' ] && set -a && source '$BOT_ENV' && set +a
  export TELEGRAM_USER_DATA='$DATA'
  export TELEGRAM_PROXY_ENABLED=\${TELEGRAM_PROXY_ENABLED:-\${PROXY_ENABLED:-0}}
  export TELEGRAM_PROXY_TYPE=\${TELEGRAM_PROXY_TYPE:-http}
  export TELEGRAM_PROXY_SERVER=\${TELEGRAM_PROXY_SERVER:-\${PROXY_SERVER:-}}
  export TELEGRAM_PROXY_PORT=\${TELEGRAM_PROXY_PORT:-\${PROXY_PORT:-}}
  export TELEGRAM_PROXY_USERNAME=\${TELEGRAM_PROXY_USERNAME:-\${PROXY_USERNAME:-}}
  export TELEGRAM_PROXY_PASSWORD=\${TELEGRAM_PROXY_PASSWORD:-\${PROXY_PASSWORD:-}}
  cd '$DIR'
  exec '$VENV' -u facil_auto_worker.py --loop
"

echo "Worker Fácil: tmux attach -t cloud-facil-worker"
sleep 3
$TMUX capture-pane -t cloud-facil-worker:0.0 -p | tail -12
