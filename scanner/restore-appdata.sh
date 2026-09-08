#!/bin/bash
# Restaura backup criado por backup-appdata.sh
# Uso: bash scanner/restore-appdata.sh [caminho_do_backup]
set -euo pipefail

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/linkclaro-bot"
BACKUP_DIR="${1:-}"

if [ -z "$BACKUP_DIR" ]; then
  if [ -f "$DATA_DIR/backups/LATEST" ]; then
    BACKUP_DIR="$(cat "$DATA_DIR/backups/LATEST")"
  elif [ -L "$DATA_DIR/backups/latest" ]; then
    BACKUP_DIR="$(readlink -f "$DATA_DIR/backups/latest")"
  fi
fi

if [ -z "$BACKUP_DIR" ] || [ ! -d "$BACKUP_DIR" ]; then
  echo "Backup não encontrado. Uso: bash scanner/restore-appdata.sh /caminho/do/backup"
  exit 1
fi

echo "Restaurando de: $BACKUP_DIR"
echo "Parando bot…"
"$DATA_DIR/stop.sh" 2>/dev/null || true

restore_file() {
  if [ -f "$BACKUP_DIR/$1" ]; then
    cp -a "$BACKUP_DIR/$1" "$DATA_DIR/$1"
    echo "  ok $1"
  fi
}

restore_file numbers.db
restore_file admin.db
restore_file .env
for f in cards-pending.txt cards-approved.txt cards-consumed.txt cards-reserved.json; do
  restore_file "$f"
done

if [ -d "$BACKUP_DIR/debug" ]; then
  rm -rf "$DATA_DIR/debug"
  cp -a "$BACKUP_DIR/debug" "$DATA_DIR/debug"
  echo "  ok debug/"
fi

echo "Reiniciando…"
"$DATA_DIR/run.sh" 2>/dev/null || bash "$(dirname "$0")/install-appdata.sh"
echo "Restauração concluída."
