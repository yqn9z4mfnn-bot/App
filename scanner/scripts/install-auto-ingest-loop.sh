#!/bin/bash
# Instala serviço systemd do loop auto-ingest (DO / VPS).
set -euo pipefail

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/linkclaro-bot"
APP_DIR="${APP_DIR:-$HOME/App/scanner}"
LOG_FILE="${AUTO_INGEST_LOG:-/tmp/auto-ingest-loop.log}"
UNIT=/etc/systemd/system/auto-ingest-loop.service

mkdir -p "$(dirname "$LOG_FILE")"

cat > "$UNIT" <<EOF
[Unit]
Description=Claro auto-ingest loop (1000/lote, pausa 2h)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=XDG_DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
Environment=NUMBERS_DB=$DATA_DIR/numbers.db
Environment=ADMIN_DB=$DATA_DIR/admin.db
Environment=AUTO_INGEST_BATCH=1000
Environment=AUTO_INGEST_PAUSE_MS=7200000
Environment=AUTO_INGEST_CONCURRENCY=1
Environment=AUTO_INGEST_LOG_EVERY=10
EnvironmentFile=-$DATA_DIR/.env
ExecStart=/usr/bin/node $APP_DIR/scripts/auto-ingest-loop.mjs
Restart=always
RestartSec=30
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable auto-ingest-loop.service
systemctl restart auto-ingest-loop.service
echo "auto-ingest-loop: $(systemctl is-active auto-ingest-loop.service)"
echo "log: tail -f $LOG_FILE"
