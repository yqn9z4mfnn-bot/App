#!/bin/bash
# Instala e roda o bot em ~/.local/share/linkclaro-bot (sem rastro no projeto)
set -euo pipefail

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/linkclaro-bot"
APP_DIR="$DATA_DIR/app"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

# Copia código (sem .env do repo)
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
cp -r "$SCRIPT_DIR/lib" "$APP_DIR/"
cp -r "$SCRIPT_DIR/automation" "$APP_DIR/"
cp -r "$SCRIPT_DIR/admin" "$APP_DIR/"
for f in "$SCRIPT_DIR"/*.mjs; do [ -f "$f" ] && cp "$f" "$APP_DIR/"; done
[ -f "$SCRIPT_DIR/package.json" ] && cp "$SCRIPT_DIR/package.json" "$APP_DIR/"
[ -f "$SCRIPT_DIR/package-lock.json" ] && cp "$SCRIPT_DIR/package-lock.json" "$APP_DIR/"
if [ -d "$SCRIPT_DIR/node_modules" ]; then
  rm -rf "$APP_DIR/node_modules"
  cp -a "$SCRIPT_DIR/node_modules" "$APP_DIR/"
else
  (cd "$APP_DIR" && npm install --omit=dev --no-fund --no-audit)
fi

# Token: usa .env local do projeto só na 1ª instalação, depois só appdata
if [ -f "$DATA_DIR/.env" ]; then
  : # mantém token existente em appdata
elif [ -f "$SCRIPT_DIR/.env" ]; then
  grep -v '^#' "$SCRIPT_DIR/.env" | grep TELEGRAM_BOT_TOKEN > "$DATA_DIR/.env"
  rm -f "$SCRIPT_DIR/.env"
else
  echo "Crie $DATA_DIR/.env com: TELEGRAM_BOT_TOKEN=seu_token"
  exit 1
fi

# Defaults da automação Edge (JWT)
touch "$DATA_DIR/.env"
grep -q '^AUTOMATION_API_URL=' "$DATA_DIR/.env" 2>/dev/null || echo 'AUTOMATION_API_URL=http://127.0.0.1:3000' >> "$DATA_DIR/.env"
grep -q '^BROWSER_NAME=' "$DATA_DIR/.env" 2>/dev/null || echo 'BROWSER_NAME=edge' >> "$DATA_DIR/.env"
grep -q '^HEADLESS=' "$DATA_DIR/.env" 2>/dev/null || echo 'HEADLESS=false' >> "$DATA_DIR/.env"
grep -q '^RECHARGE_MODE=' "$DATA_DIR/.env" 2>/dev/null || echo 'RECHARGE_MODE=browser' >> "$DATA_DIR/.env"
grep -q '^PROXY_ENABLED=' "$DATA_DIR/.env" 2>/dev/null || echo 'PROXY_ENABLED=0' >> "$DATA_DIR/.env"
grep -q '^PROXY_ROTATE=' "$DATA_DIR/.env" 2>/dev/null || echo 'PROXY_ROTATE=0' >> "$DATA_DIR/.env"
grep -q '^PROXY_LOG_IP=' "$DATA_DIR/.env" 2>/dev/null || echo 'PROXY_LOG_IP=0' >> "$DATA_DIR/.env"
grep -q '^CLARO_LINK_TIMEOUT_MS=' "$DATA_DIR/.env" 2>/dev/null || echo 'CLARO_LINK_TIMEOUT_MS=12000' >> "$DATA_DIR/.env"
grep -q '^CLARO_LINK_429_BACKOFF_MS=' "$DATA_DIR/.env" 2>/dev/null || echo 'CLARO_LINK_429_BACKOFF_MS=800' >> "$DATA_DIR/.env"
grep -q '^THREEDS_CONTINUE_GATE_WAIT=' "$DATA_DIR/.env" 2>/dev/null || echo 'THREEDS_CONTINUE_GATE_WAIT=1' >> "$DATA_DIR/.env"
grep -q '^THREEDS_UI_WAIT_MS=' "$DATA_DIR/.env" 2>/dev/null || echo 'THREEDS_UI_WAIT_MS=8000' >> "$DATA_DIR/.env"
grep -q '^THREEDS_EXTRA_WAIT_MS=' "$DATA_DIR/.env" 2>/dev/null || echo 'THREEDS_EXTRA_WAIT_MS=12000' >> "$DATA_DIR/.env"
grep -q '^KEEP_BROWSER_OPEN_3DS_SECONDS=' "$DATA_DIR/.env" 2>/dev/null || echo 'KEEP_BROWSER_OPEN_3DS_SECONDS=0' >> "$DATA_DIR/.env"
grep -q '^VNC_ON_3DS=' "$DATA_DIR/.env" 2>/dev/null || echo 'VNC_ON_3DS=0' >> "$DATA_DIR/.env"
grep -q '^ADMIN_PORT=' "$DATA_DIR/.env" 2>/dev/null || echo 'ADMIN_PORT=3080' >> "$DATA_DIR/.env"
if ! grep -q '^ADMIN_PASSWORD=' "$DATA_DIR/.env" 2>/dev/null; then
  ADMIN_PW="$(openssl rand -hex 12 2>/dev/null || head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)"
  echo "ADMIN_PASSWORD=${ADMIN_PW}" >> "$DATA_DIR/.env"
  echo "Senha admin gerada: ${ADMIN_PW} (salva em $DATA_DIR/.env)"
fi

chmod 600 "$DATA_DIR/.env"

cat > "$DATA_DIR/run.sh" << 'RUNEOF'
#!/bin/bash
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/linkclaro-bot"
APP_DIR="$DATA_DIR/app"
PID_FILE="$DATA_DIR/bot.pid"
AUTO_PID_FILE="$DATA_DIR/automation.pid"
ADMIN_PID_FILE="$DATA_DIR/admin.pid"
LOG_FILE="$DATA_DIR/bot.log"
AUTO_LOG_FILE="$DATA_DIR/automation.log"
ADMIN_LOG_FILE="$DATA_DIR/admin.log"

export HISTFILE=/dev/null
set -a
source "$DATA_DIR/.env"
set +a
export NUMBERS_DB="$DATA_DIR/numbers.db"

cd "$APP_DIR"

# Automação Playwright (Edge + JWT)
if [ -f "$AUTO_PID_FILE" ] && kill -0 "$(cat "$AUTO_PID_FILE")" 2>/dev/null; then
  echo "Automação já rodando (PID $(cat "$AUTO_PID_FILE"))"
else
  nohup node automation/run.mjs >> "$AUTO_LOG_FILE" 2>&1 &
  echo $! > "$AUTO_PID_FILE"
  disown 2>/dev/null || true
  echo "Automação iniciada PID $(cat "$AUTO_PID_FILE")"
fi

# Painel admin web
if [ -f "$ADMIN_PID_FILE" ] && kill -0 "$(cat "$ADMIN_PID_FILE")" 2>/dev/null; then
  echo "Admin já rodando (PID $(cat "$ADMIN_PID_FILE"))"
else
  nohup node admin/run.mjs >> "$ADMIN_LOG_FILE" 2>&1 &
  echo $! > "$ADMIN_PID_FILE"
  disown 2>/dev/null || true
  echo "Admin iniciado PID $(cat "$ADMIN_PID_FILE") — http://127.0.0.1:${ADMIN_PORT:-3080}"
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Bot já rodando (PID $(cat "$PID_FILE"))"
  exit 0
fi

nohup node telegram-bot.mjs >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
disown 2>/dev/null || true
echo "Bot iniciado PID $(cat "$PID_FILE")"
echo "Dados: $DATA_DIR"
RUNEOF

cat > "$DATA_DIR/stop.sh" << 'STOPEOF'
#!/bin/bash
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/linkclaro-bot"
PID_FILE="$DATA_DIR/bot.pid"
AUTO_PID_FILE="$DATA_DIR/automation.pid"
ADMIN_PID_FILE="$DATA_DIR/admin.pid"
if [ -f "$PID_FILE" ]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null && rm -f "$PID_FILE" && echo "Bot parado"
else
  pkill -f "$DATA_DIR/app/telegram-bot.mjs" 2>/dev/null && echo "Bot parado" || echo "Bot não estava rodando"
fi
if [ -f "$AUTO_PID_FILE" ]; then
  kill "$(cat "$AUTO_PID_FILE")" 2>/dev/null && rm -f "$AUTO_PID_FILE" && echo "Automação parada"
else
  pkill -f "$DATA_DIR/app/automation/run.mjs" 2>/dev/null && echo "Automação parada" || true
fi
if [ -f "$ADMIN_PID_FILE" ]; then
  kill "$(cat "$ADMIN_PID_FILE")" 2>/dev/null && rm -f "$ADMIN_PID_FILE" && echo "Admin parado"
else
  pkill -f "$DATA_DIR/app/admin/run.mjs" 2>/dev/null && echo "Admin parado" || true
fi
STOPEOF

cat > "$DATA_DIR/clear.sh" << 'CLEAREOF'
#!/bin/bash
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/linkclaro-bot"
"$DATA_DIR/stop.sh" 2>/dev/null || true
rm -f "$DATA_DIR/bot.log" "$DATA_DIR/bot.pid" "$DATA_DIR/automation.log" "$DATA_DIR/automation.pid" "$DATA_DIR/admin.log" "$DATA_DIR/admin.pid"
echo "Logs e PID limpos em $DATA_DIR"
CLEAREOF

chmod +x "$DATA_DIR/run.sh" "$DATA_DIR/stop.sh" "$DATA_DIR/clear.sh"
cp "$SCRIPT_DIR/backup-appdata.sh" "$DATA_DIR/backup.sh"
cp "$SCRIPT_DIR/restore-appdata.sh" "$DATA_DIR/restore.sh"
chmod +x "$DATA_DIR/backup.sh" "$DATA_DIR/restore.sh"

# Para instâncias antigas (workspace ou appdata)
pkill -f "telegram-bot.mjs" 2>/dev/null || true
pkill -f "automation/run.mjs" 2>/dev/null || true
pkill -f "automation/server.mjs" 2>/dev/null || true
pkill -f "admin/run.mjs" 2>/dev/null || true
sleep 1

bash "$DATA_DIR/run.sh"
