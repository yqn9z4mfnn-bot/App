#!/bin/bash
# Sobe a API Playwright (automação anti-fraude) em tmux
set -euo pipefail
DIR="$(cd "$(dirname "$0")/automation-server" && pwd)"
SESSION="automation-server"
TMUX="tmux -f /exec-daemon/tmux.portal.conf"

if curl -sf http://127.0.0.1:3000/health >/dev/null 2>&1; then
  echo "Automação já online em http://127.0.0.1:3000"
  exit 0
fi

$TMUX kill-session -t "=$SESSION" 2>/dev/null || true
$TMUX new-session -d -s "$SESSION" -c "$DIR" -- "${SHELL:-bash}" -l
$TMUX send-keys -t "$SESSION:0.0" "cd \"$DIR\" && BYPASS_3DS=true HEADLESS=true SKIP_CS_CAPTURE=1 node server.js 2>&1 | tee /tmp/automation-server.log" C-m

for i in $(seq 1 15); do
  if curl -sf http://127.0.0.1:3000/health >/dev/null 2>&1; then
    echo "Automação online em http://127.0.0.1:3000 (tmux: $SESSION)"
    exit 0
  fi
  sleep 1
done

echo "Falha ao subir automação — veja /tmp/automation-server.log"
exit 1
