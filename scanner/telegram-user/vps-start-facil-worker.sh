#!/bin/bash
# Worker automático contínuo: grupo Fácil → bot Linkclaro
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TMUX="${TMUX_CMD:-tmux -S /tmp/tmux-0/default}"
VENV="$DIR/.venv/bin/python3"

# Mesma sessão Telethon — não rodar keepalive em paralelo
"$DIR/vps-stop-telegram-user.sh" 2>/dev/null || true
pkill -f "facil_auto_worker.py" 2>/dev/null || true
sleep 1

PAYLOAD="${1:-}"
PEDIDO="${2:-}"
EXTRA=(--loop)
[ -n "$PAYLOAD" ] && EXTRA+=(--payload "$PAYLOAD")
[ -n "$PEDIDO" ] && EXTRA+=(--pedido "$PEDIDO")

$TMUX kill-session -t facil-auto-worker 2>/dev/null || true
$TMUX new-session -d -s facil-auto-worker -c "$DIR" -- bash -lc "
  set -a; source '$DIR/.env'; set +a
  export TELEGRAM_USER_DATA='${TELEGRAM_USER_DATA:-/root/.local/share/telegram-user}'
  cd '$DIR'
  exec '$VENV' -u facil_auto_worker.py ${EXTRA[*]} >>/tmp/facil-worker.log 2>&1
"

echo "Worker Fácil (loop): tmux attach -t facil-auto-worker"
sleep 2
$TMUX capture-pane -t facil-auto-worker -p | tail -8
