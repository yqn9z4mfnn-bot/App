#!/bin/bash
# Loop do vigia a cada 15 min (substituto quando cron/cursor timer falham). Não altera .env/proxy.
set -euo pipefail
APP_DIR="/workspace/scanner"
DATA_DIR="${XDG_DATA_HOME:-/home/ubuntu/.local/share/cloud-bot-home}/linkclaro-bot"
INTERVAL="${CLOUD_VIGIA_INTERVAL_SEC:-900}"
mkdir -p "$DATA_DIR/logs"
cd "$APP_DIR"
echo "[cloud-vigia-daemon] intervalo=${INTERVAL}s pid=$$ $(date -u +%Y-%m-%dT%H:%M:%SZ)"
while true; do
  bash "$APP_DIR/cloud-vigia-check.sh" >> "$DATA_DIR/logs/cloud-vigia-cron.log" 2>&1 || true
  sleep "$INTERVAL"
done
