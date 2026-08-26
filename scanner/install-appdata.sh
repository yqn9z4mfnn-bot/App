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
cp -r "$SCRIPT_DIR"/lib "$SCRIPT_DIR"/*.mjs "$SCRIPT_DIR"/package.json "$APP_DIR/" 2>/dev/null || true
cp -r "$SCRIPT_DIR/lib" "$APP_DIR/"
for f in "$SCRIPT_DIR"/*.mjs; do [ -f "$f" ] && cp "$f" "$APP_DIR/"; done
[ -f "$SCRIPT_DIR/package.json" ] && cp "$SCRIPT_DIR/package.json" "$APP_DIR/"

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

chmod 600 "$DATA_DIR/.env"

cat > "$DATA_DIR/run.sh" << 'RUNEOF'
#!/bin/bash
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/linkclaro-bot"
APP_DIR="$DATA_DIR/app"
PID_FILE="$DATA_DIR/bot.pid"
LOG_FILE="$DATA_DIR/bot.log"

export HISTFILE=/dev/null
set -a
source "$DATA_DIR/.env"
set +a

# Sobe automação Playwright antes do bot (se script configurado)
if [ -n "${AUTOMATION_API_URL:-}" ] && [ -n "${AUTOMATION_START_SCRIPT:-}" ] && [ -f "$AUTOMATION_START_SCRIPT" ]; then
  bash "$AUTOMATION_START_SCRIPT" >> "$LOG_FILE" 2>&1 || true
fi

cd "$APP_DIR"

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
if [ -f "$PID_FILE" ]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null && rm -f "$PID_FILE" && echo "Bot parado"
else
  pkill -f "$DATA_DIR/app/telegram-bot.mjs" 2>/dev/null && echo "Bot parado" || echo "Bot não estava rodando"
fi
STOPEOF

cat > "$DATA_DIR/clear.sh" << 'CLEAREOF'
#!/bin/bash
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/linkclaro-bot"
"$DATA_DIR/stop.sh" 2>/dev/null || true
rm -f "$DATA_DIR/bot.log" "$DATA_DIR/bot.pid"
echo "Logs e PID limpos em $DATA_DIR"
CLEAREOF

chmod +x "$DATA_DIR/run.sh" "$DATA_DIR/stop.sh" "$DATA_DIR/clear.sh"

# Para instâncias antigas (workspace ou appdata)
pkill -f "telegram-bot.mjs" 2>/dev/null || true
sleep 1

bash "$DATA_DIR/run.sh"
