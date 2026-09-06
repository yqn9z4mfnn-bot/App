#!/bin/bash
# Worker automático: grupo Fácil → bot Linkclaro
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TMUX="${TMUX_CMD:-tmux -S /tmp/tmux-0/default}"
VENV="$DIR/.venv/bin/python3"

# Para keepalive tg-user (mesma sessão Telethon)
$DIR/vps-stop-telegram-user.sh 2>/dev/null || true
pkill -f "facil_auto_worker.py" 2>/dev/null || true
sleep 1

PAYLOAD="${1:-}"
PEDIDO="${2:-}"
EXTRA=()
[ -n "$PAYLOAD" ] && EXTRA+=(--payload "$PAYLOAD")
[ -n "$PEDIDO" ] && EXTRA+=(--pedido "$PEDIDO")

$TMUX kill-session -t facil-auto-worker 2>/dev/null || true
$TMUX new-session -d -s facil-auto-worker -c "$DIR" -- bash -lc "
  cd '$DIR'
  exec '$VENV' facil_auto_worker.py ${EXTRA[*]}
"

echo "Worker: tmux attach -t facil-auto-worker"
echo "Log: tmux attach -t facil-auto-worker"
