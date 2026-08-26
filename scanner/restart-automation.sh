#!/bin/bash
# Reinicia automação (força HEADLESS=false por padrão — Eldorado monta melhor)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION="automation-server"
TMUX="tmux -f /exec-daemon/tmux.portal.conf"

kill -9 $(pgrep -f "node server.js" 2>/dev/null) 2>/dev/null || true
$TMUX kill-session -t "=$SESSION" 2>/dev/null || true
sleep 1

export HEADLESS="${HEADLESS:-false}"
bash "$DIR/start-automation.sh"

curl -s http://127.0.0.1:3000/health | python3 -m json.tool 2>/dev/null || true
