#!/bin/bash
# VPS: sessão Telegram (conta de usuário) em tmux tg-user
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${TELEGRAM_USER_DATA:-/root/.local/share/telegram-user}"
TMUX="${TMUX_CMD:-tmux -S /tmp/tmux-0/default}"
VENV="$DIR/.venv"
PYTHON="$VENV/bin/python3"

if [ ! -x "$PYTHON" ]; then
  echo "Ambiente Python ausente. Rode: bash $DIR/vps-install-telegram-user.sh"
  exit 1
fi

mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

if [ ! -f "$DIR/.env" ]; then
  echo "Crie $DIR/.env a partir de .env.example (API_ID, API_HASH, TELEGRAM_PHONE)"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "$DIR/.env"
set +a
export TELEGRAM_USER_DATA="$DATA_DIR"

if ! "$PYTHON" "$DIR/auth.py" status >/dev/null 2>&1; then
  echo "Sessão ainda não logada. Rode:"
  echo "  cd $DIR && $PYTHON auth.py request-code"
  echo "  cd $DIR && $PYTHON auth.py sign-in CODIGO"
  exit 1
fi

$TMUX kill-session -t tg-user 2>/dev/null || true
$TMUX new-session -d -s tg-user -c "$DIR" -- bash -lc "
  set -a; source '$DIR/.env'; set +a
  export TELEGRAM_USER_DATA='$DATA_DIR'
  cd '$DIR'
  exec '$PYTHON' keepalive.py
"

echo "Telegram user keepalive: tmux attach -t tg-user"
"$PYTHON" "$DIR/auth.py" status
