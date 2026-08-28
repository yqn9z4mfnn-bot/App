#!/bin/bash
# Backup do bot (~/.local/share/linkclaro-bot) antes de mudanças arriscadas.
set -euo pipefail

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/linkclaro-bot"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$DATA_DIR/backups/$STAMP"

mkdir -p "$BACKUP_DIR"

copy_if_exists() {
  if [ -f "$1" ]; then
    cp -a "$1" "$BACKUP_DIR/"
  fi
}

copy_if_exists "$DATA_DIR/numbers.db"
copy_if_exists "$DATA_DIR/.env"
copy_if_exists "$DATA_DIR/bot.log"
copy_if_exists "$DATA_DIR/automation.log"

if [ -d "$DATA_DIR/debug" ]; then
  cp -a "$DATA_DIR/debug" "$BACKUP_DIR/"
fi

cat > "$BACKUP_DIR/manifest.txt" <<EOF
backup_at=$STAMP
data_dir=$DATA_DIR
hostname=$(hostname 2>/dev/null || echo unknown)
EOF

mkdir -p "$DATA_DIR/backups"
echo "$BACKUP_DIR" > "$DATA_DIR/backups/LATEST"
ln -sfn "$BACKUP_DIR" "$DATA_DIR/backups/latest"

echo "Backup salvo em: $BACKUP_DIR"
ls -la "$BACKUP_DIR"
