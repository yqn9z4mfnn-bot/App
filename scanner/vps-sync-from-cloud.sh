#!/bin/bash
# Sincroniza código + vars de runtime da nuvem → VPS (preserva token, dados, ADMIN_PASSWORD).
set -euo pipefail

VPS_HOST="${VPS_HOST:-root@147.93.13.252}"
VPS_PASS="${VPS_PASS:?defina VPS_PASS}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Empacotando scanner..."
TMP_TAR="$(mktemp /tmp/scanner-sync.XXXXXX.tar.gz)"
tar czf "$TMP_TAR" -C "$REPO_ROOT" \
  --exclude='scanner/node_modules' \
  --exclude='scanner/.env' \
  scanner

echo "==> Enviando..."
sshpass -p "$VPS_PASS" scp -o StrictHostKeyChecking=accept-new "$TMP_TAR" "$VPS_HOST:/tmp/scanner-sync.tar.gz"
rm -f "$TMP_TAR"

echo "==> Aplicando na VPS..."
sshpass -p "$VPS_PASS" ssh -o StrictHostKeyChecking=accept-new "$VPS_HOST" bash -s <<'REMOTE'
set -euo pipefail
DATA=/root/.local/share/linkclaro-bot
ENV_FILE="$DATA/.env"

# Preservar segredos VPS
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
ADMIN_PW=$(grep '^ADMIN_PASSWORD=' "$ENV_FILE" | cut -d= -f2- || true)

# Código (mantém node_modules se existir — npm install atualiza deps)
if [ -d /root/App/scanner/node_modules ]; then
  mv /root/App/scanner/node_modules /tmp/scanner-node_modules.bak
fi
rm -rf /root/App/scanner
mkdir -p /root/App
tar xzf /tmp/scanner-sync.tar.gz -C /root/App
rm -f /tmp/scanner-sync.tar.gz
if [ -d /tmp/scanner-node_modules.bak ]; then
  rm -rf /root/App/scanner/node_modules
  mv /tmp/scanner-node_modules.bak /root/App/scanner/node_modules
fi

cd /root/App/scanner
npm install --omit=dev --no-fund --no-audit
npx playwright install msedge 2>/dev/null || true

# .env runtime = nuvem (paths/token VPS)
cat > "$ENV_FILE" <<ENV
TELEGRAM_BOT_TOKEN=${TOKEN}
PROXY_ENABLED=0
AUTOMATION_API_URL=http://127.0.0.1:3000
AUTOMATION_PORT=3000
BROWSER_NAME=edge
HEADLESS=false
RECHARGE_MODE=browser
RECHARGE_BROWSER_FLOW=checkout-link
NUMBERS_DB=/root/.local/share/linkclaro-bot/numbers.db
ADMIN_DB=/root/.local/share/linkclaro-bot/admin.db
ADMIN_PORT=3080
ADMIN_PASSWORD=${ADMIN_PW}
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
THREEDS_STOP_ON_VBV=1
XDG_DATA_HOME=/root/.local/share
ENV
chmod 600 "$ENV_FILE"

export XDG_DATA_HOME=/root/.local/share
export APP_DIR=/root/App/scanner
bash /root/App/scanner/vps-start-services.sh

sleep 4
echo "=== health ==="
curl -sf http://127.0.0.1:3000/health
echo ""
echo "=== .env browser/runtime ==="
grep -E "^(THREEDS|CLOSE_ALL|MAX_AUTO|BROWSER|HEADLESS|RECHARGE|PROXY_ENABLED)" "$ENV_FILE"
echo "=== processos ==="
pgrep -af 'node (telegram-bot|automation/run)' | grep -E '^[0-9]+ node' || true
REMOTE

echo "==> Sync VPS concluído."
