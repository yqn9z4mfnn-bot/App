#!/bin/bash
# Ativa vigia recorrente: o Cloud Agent recebe follow-up a cada 30 min (via subscribe_timer).
# Rode UMA VEZ dentro de um Cloud Agent com MCP cursor-subscriptions.
set -euo pipefail
echo "Vigia configurada pelo agente Cursor (subscribe_timer: cloud-bot-vigia)."
echo "Check manual: bash $(dirname "$0")/cloud-vigia-check.sh"
echo "Reinício se necessário: bash $(dirname "$0")/cloud-start-services.sh"
