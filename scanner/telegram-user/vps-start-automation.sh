#!/bin/bash
# VPS: bot + automação browser + worker Fácil RECARGAS
set -euo pipefail

APP_DIR="${APP_DIR:-/root/App/scanner}"
TG_DIR="${TG_DIR:-/root/App/telegram-user}"
TMUX="${TMUX_CMD:-tmux -S /tmp/tmux-0/default}"

echo "==> Serviços scanner (bot + automation + admin)"
bash "$APP_DIR/vps-start-services.sh"

echo "==> Worker Fácil RECARGAS (Telegram user)"
bash "$TG_DIR/vps-start-facil-worker.sh"

echo ""
echo "=== Sessões tmux ==="
$TMUX ls 2>/dev/null || true
echo ""
echo "Monitor worker: tmux attach -t facil-auto-worker"
echo "Monitor bot:    tmux attach -t vps-telegram-bot"
echo "Monitor auto:   tmux attach -t vps-automation"
