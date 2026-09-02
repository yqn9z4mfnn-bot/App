#!/bin/bash
# Deploy na VPS 147.93.13.252 — banco limpo, token novo. NÃO roda na nuvem.
set -euo pipefail

VPS_HOST="${VPS_HOST:-root@147.93.13.252}"
VPS_PASS="${VPS_PASS:?defina VPS_PASS}"
NEW_TOKEN="${NEW_TOKEN:?defina NEW_TOKEN}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ADMIN_PW="$(openssl rand -hex 12 2>/dev/null || head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)"

echo "==> Empacotando código (scanner)..."
TMP_TAR="$(mktemp /tmp/scanner-deploy.XXXXXX.tar.gz)"
tar czf "$TMP_TAR" -C "$REPO_ROOT" \
  --exclude='scanner/node_modules' \
  --exclude='scanner/.env' \
  scanner

echo "==> Enviando para VPS..."
sshpass -p "$VPS_PASS" scp -o StrictHostKeyChecking=accept-new "$TMP_TAR" "$VPS_HOST:/tmp/scanner-deploy.tar.gz"
rm -f "$TMP_TAR"

echo "==> Configurando VPS (dados limpos)..."
sshpass -p "$VPS_PASS" ssh -o StrictHostKeyChecking=accept-new "$VPS_HOST" bash -s <<REMOTE
set -euo pipefail
NEW_TOKEN='$NEW_TOKEN'
ADMIN_PW='$ADMIN_PW'

# Parar serviços antigos
pkill -f 'telegram-bot.mjs' 2>/dev/null || true
pkill -f 'automation/run.mjs' 2>/dev/null || true
pkill -f 'admin/run.mjs' 2>/dev/null || true
tmux kill-session -t vps-automation 2>/dev/null || true
tmux kill-session -t vps-telegram-bot 2>/dev/null || true
tmux kill-session -t vps-admin 2>/dev/null || true
sleep 2

# Código
mkdir -p /root/App
rm -rf /root/App/scanner
tar xzf /tmp/scanner-deploy.tar.gz -C /root/App
rm -f /tmp/scanner-deploy.tar.gz

# Dados limpos
DATA=/root/.local/share/linkclaro-bot
mkdir -p "\$DATA"
rm -f "\$DATA"/admin.db "\$DATA"/admin.db-wal "\$DATA"/admin.db-shm
rm -f "\$DATA"/numbers.db "\$DATA"/numbers.db-wal "\$DATA"/numbers.db-shm
rm -f "\$DATA"/cards-pending.txt "\$DATA"/cards-approved.txt "\$DATA"/cards-consumed.txt
rm -f "\$DATA"/cards-reserved.json
touch "\$DATA"/cards-pending.txt "\$DATA"/cards-approved.txt "\$DATA"/cards-consumed.txt
echo '{"reservations":[]}' > "\$DATA"/cards-reserved.json

cat > "\$DATA/.env" <<ENV
TELEGRAM_BOT_TOKEN=\${NEW_TOKEN}
PROXY_ENABLED=0
AUTOMATION_API_URL=http://127.0.0.1:3000
AUTOMATION_PORT=3000
BROWSER_NAME=edge
BROWSER_USE_PLAYWRIGHT_CHROMIUM=0
HEADLESS=false
RECHARGE_MODE=browser
RECHARGE_BROWSER_FLOW=checkout-link
NUMBERS_DB=/root/.local/share/linkclaro-bot/numbers.db
ADMIN_DB=/root/.local/share/linkclaro-bot/admin.db
ADMIN_PORT=3080
ADMIN_PASSWORD=\${ADMIN_PW}
PROXY_SERVER=proxy.smartproxy.net
PROXY_PORT=3120
PROXY_USERNAME=smart-jr4ws4t0cq04_area-BR
PROXY_PASSWORD=IJTAmdYaMo0b37MC
PROXY_ROTATE=0
PROXY_PAYMENT_ONLY=0
PROXY_LOG_IP=0
CLARO_API_429_RETRIES=4
CLARO_LINK_TIMEOUT_MS=12000
CLARO_LINK_429_RETRIES=5
CLARO_LINK_429_BACKOFF_MS=800
PROXY_CONNECT_TIMEOUT_MS=10000
MAX_AUTO_RECHARGE_RETRIES=1
THREEDS_STOP_ON_VBV=0
THREEDS_CONTINUE_GATE_WAIT=1
THREEDS_UI_WAIT_MS=8000
THREEDS_EXTRA_WAIT_MS=12000
XDG_DATA_HOME=/root/.local/share
ENV
chmod 600 "\$DATA/.env"

cd /root/App/scanner
npm install --omit=dev --no-fund --no-audit
npx playwright install msedge 2>/dev/null || true

export XDG_DATA_HOME=/root/.local/share
export APP_DIR=/root/App/scanner
bash /root/App/scanner/vps-start-services.sh

sleep 4
curl -sf http://127.0.0.1:3000/health && echo
pgrep -af 'telegram-bot|automation/run' | grep -v pgrep || true
echo "ADMIN_PASSWORD=\${ADMIN_PW}"
REMOTE

echo "==> Deploy concluído."
