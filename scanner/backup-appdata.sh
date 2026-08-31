#!/bin/bash
# Backup local do bot (~/.local/share/linkclaro-bot) — inclui cartões, DBs e env.
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

echo "Checkpoint SQLite…"
for db in admin.db numbers.db; do
  if [ -f "$DATA_DIR/$db" ]; then
    sqlite3 "$DATA_DIR/$db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null || true
    sqlite3 "$DATA_DIR/$db" ".backup '$BACKUP_DIR/$db'"
  fi
done

copy_if_exists "$DATA_DIR/.env"
copy_if_exists "$DATA_DIR/bot.log"
copy_if_exists "$DATA_DIR/automation.log"
for f in cards-pending.txt cards-approved.txt cards-consumed.txt cards-reserved.json; do
  copy_if_exists "$DATA_DIR/$f"
done

if [ -d "$DATA_DIR/debug" ]; then
  cp -a "$DATA_DIR/debug" "$BACKUP_DIR/"
fi

cat > "$BACKUP_DIR/manifest.txt" <<EOF
backup_at=$STAMP
data_dir=$DATA_DIR
hostname=$(hostname 2>/dev/null || echo unknown)
cards_pending=$(wc -l < "$DATA_DIR/cards-pending.txt" 2>/dev/null || echo 0)
cards_approved=$(wc -l < "$DATA_DIR/cards-approved.txt" 2>/dev/null || echo 0)
cards_consumed=$(wc -l < "$DATA_DIR/cards-consumed.txt" 2>/dev/null || echo 0)
EOF

mkdir -p "$DATA_DIR/backups"
echo "$BACKUP_DIR" > "$DATA_DIR/backups/LATEST"
ln -sfn "$BACKUP_DIR" "$DATA_DIR/backups/latest"

echo "Backup salvo em: $BACKUP_DIR"
ls -la "$BACKUP_DIR"
