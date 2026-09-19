#!/bin/bash
# Para o worker Fácil na nuvem (preserva worker-current / sessão Telethon).
set -euo pipefail
XDG_DATA_HOME="${XDG_DATA_HOME:-/home/ubuntu/.local/share/cloud-bot-home}"
DATA_DIR="$XDG_DATA_HOME/linkclaro-bot"
TU="${TELEGRAM_USER_DATA:-$XDG_DATA_HOME/telegram-user}"
TMUX="${TMUX_CMD:-tmux -f /exec-daemon/tmux.portal.conf}"
PAUSE_FILE="$DATA_DIR/facil-worker.paused"

touch "$PAUSE_FILE"
date -u +%Y-%m-%dT%H:%M:%SZ >"$PAUSE_FILE"

$TMUX kill-session -t cloud-facil-worker 2>/dev/null || true
pkill -f "facil_auto_worker.py" 2>/dev/null || true
sleep 1
rm -f "$TU/facil-auto-worker.lock" 2>/dev/null || true

if pgrep -f "facil_auto_worker.py" >/dev/null; then
  echo "Worker Fácil: ainda rodando (verifique manualmente)"
  exit 1
fi
echo "Worker Fácil: PAUSADO (flag $PAUSE_FILE — vigia não reinicia)"
echo "Para retomar: bash $(dirname "$0")/cloud-start-facil-worker.sh"
