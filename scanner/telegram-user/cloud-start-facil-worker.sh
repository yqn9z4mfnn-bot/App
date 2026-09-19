#!/bin/bash
set -euo pipefail
XDG_DATA_HOME="${XDG_DATA_HOME:-/home/ubuntu/.local/share/cloud-bot-home}"
DATA_DIR="$XDG_DATA_HOME/linkclaro-bot"
DIR="$(cd "$(dirname "$0")" && pwd)"
TU="${TELEGRAM_USER_DATA:-$XDG_DATA_HOME/telegram-user}"
PAUSE_FILE="$DATA_DIR/facil-worker.paused"
TMUX="${TMUX_CMD:-tmux -f /exec-daemon/tmux.portal.conf}"
PY="$DIR/.venv/bin/python3"

rm -f "$PAUSE_FILE" 2>/dev/null || true
PIP="$DIR/.venv/bin/pip"

if [ ! -x "$PY" ] || ! "$PY" -c "import telethon" 2>/dev/null; then
  python3 -m venv "$DIR/.venv"
  "$PIP" install -q -r "$DIR/requirements.txt"
fi

pkill -f "facil_auto_worker.py" 2>/dev/null || true
sleep 1
rm -f "$TU/facil-auto-worker.lock"

$TMUX kill-session -t cloud-facil-worker 2>/dev/null || true
$TMUX new-session -d -s cloud-facil-worker -c "$DIR" -- bash -lc "
  set -a
  source '$DIR/.env'
  source '$DATA_DIR/.env'
  set +a
  export TELEGRAM_USER_DATA='$TU'
  export TELEGRAM_PROXY_ENABLED=\${TELEGRAM_PROXY_ENABLED:-1}
  export TELEGRAM_PROXY_TYPE=\${TELEGRAM_PROXY_TYPE:-socks5}
  export TELEGRAM_PROXY_SERVER=\${TELEGRAM_PROXY_SERVER:-\${PROXY_SERVER:-}}
  export TELEGRAM_PROXY_PORT=\${TELEGRAM_PROXY_PORT:-\${PROXY_PORT:-}}
  export TELEGRAM_PROXY_USERNAME=\${TELEGRAM_PROXY_USERNAME:-\${PROXY_USERNAME:-}}
  export TELEGRAM_PROXY_PASSWORD=\${TELEGRAM_PROXY_PASSWORD:-\${PROXY_PASSWORD:-}}
  cd '$DIR'
  exec '$PY' -u facil_auto_worker.py --loop >>'$DATA_DIR/logs/facil-worker.log' 2>&1
"

sleep 4
if pgrep -f "facil_auto_worker.py" >/dev/null; then
  echo "Worker Fácil: OK (tmux attach -t cloud-facil-worker)"
  tail -5 "$DATA_DIR/logs/facil-worker.log" 2>/dev/null || true
else
  echo "Worker Fácil: FALHOU ao subir"
  tail -20 "$DATA_DIR/logs/facil-worker.log" 2>/dev/null || true
  exit 1
fi
