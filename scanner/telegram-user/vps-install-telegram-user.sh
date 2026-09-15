#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$DIR/.venv"

python3 -m venv "$VENV"
"$VENV/bin/pip" install -q -U pip
"$VENV/bin/pip" install -q -r "$DIR/requirements.txt"
chmod +x "$DIR"/*.sh "$DIR"/*.py
mkdir -p /root/.local/share/telegram-user
chmod 700 /root/.local/share/telegram-user
[ -f "$DIR/.env" ] || cp "$DIR/.env.example" "$DIR/.env"
chmod 600 "$DIR/.env"
"$VENV/bin/python" -c "import telethon; print('telethon', telethon.__version__, 'OK')"
