#!/bin/bash
# Vigia nuvem: status dos serviços (sem alterar .env/proxy).
set -euo pipefail
export XDG_DATA_HOME="${XDG_DATA_HOME:-/home/ubuntu/.local/share/cloud-bot-home}"
TMUX="tmux -f /exec-daemon/tmux.portal.conf"

echo "=== cloud-vigia $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo "--- tmux ---"
$TMUX ls 2>/dev/null || echo "(sem sessões tmux)"
echo "--- processos ---"
pgrep -af "node (telegram-bot|automation/run|admin/run)" 2>/dev/null || echo "(node bot/auto/admin ausentes)"
if pgrep -f "facil_auto_worker.py" >/dev/null 2>&1; then
  pgrep -af "facil_auto_worker.py"
else
  echo "(worker Fácil PARADO — reiniciando…)"
  bash /workspace/scanner/telegram-user/cloud-start-facil-worker.sh
  sleep 3
  pgrep -af "facil_auto_worker.py" 2>/dev/null || echo "(worker ainda ausente após restart)"
fi
echo "--- health ---"
curl -sf http://127.0.0.1:3000/health 2>/dev/null || echo "automation: FALHOU"
curl -sf -o /dev/null -w "admin HTTP %{http_code}\n" http://127.0.0.1:3080/ 2>/dev/null || echo "admin: FALHOU"
echo "--- proxy ---"
grep -E '^PROXY_ENABLED=' "$XDG_DATA_HOME/linkclaro-bot/.env" 2>/dev/null || true
