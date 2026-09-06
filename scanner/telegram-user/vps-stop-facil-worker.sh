#!/bin/bash
# Para worker Fácil (preserva sessão Telegram)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TMUX="${TMUX_CMD:-tmux -S /tmp/tmux-0/default}"

$TMUX kill-session -t facil-auto-worker 2>/dev/null || true
pkill -f "facil_auto_worker.py" 2>/dev/null || true
rm -f "${TELEGRAM_USER_DATA:-/root/.local/share/telegram-user}/facil-auto-worker.lock" 2>/dev/null || true
# NÃO apaga worker-current.json — é o pedido ativo; apagar faz o worker reivindicar outro
echo "facil-auto-worker parado (worker-current preservado)"
