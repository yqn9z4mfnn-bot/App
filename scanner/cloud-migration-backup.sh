#!/bin/bash
# Backup completo da nuvem — dados, filas GG por usuário, logs, PKI, código e exports.
set -euo pipefail

ROOT="${XDG_DATA_HOME:-$HOME/.local/share/cloud-bot-home}"
DATA_DIR="$ROOT/linkclaro-bot"
WORKSPACE="${WORKSPACE:-/workspace}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="$WORKSPACE/backups/cloud-backup-$STAMP"
ARCHIVE="$WORKSPACE/backups/cloud-backup-$STAMP.tar.gz"
DEST_BOT="$OUT_DIR/data/linkclaro-bot"

mkdir -p "$OUT_DIR/data" "$OUT_DIR/code" "$OUT_DIR/exports" "$DEST_BOT"

echo "[1/7] Checkpoint SQLite (admin + numbers)…"
for db in admin.db numbers.db; do
  if [ -f "$DATA_DIR/$db" ]; then
    sqlite3 "$DATA_DIR/$db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null || true
    sqlite3 "$DATA_DIR/$db" ".backup '$DEST_BOT/$db'"
  fi
done

echo "[2/7] Copiando linkclaro-bot (env, filas, cards-users, logs, debug, scripts)…"
copy_tree() {
  local src="$1"
  local rel="$2"
  if [ -e "$src" ]; then
    mkdir -p "$(dirname "$DEST_BOT/$rel")"
    cp -a "$src" "$DEST_BOT/$rel"
  fi
}

copy_tree "$DATA_DIR/.env" ".env"
copy_tree "$DATA_DIR/cards-reserved.json" "cards-reserved.json"
for f in cards-pending.txt cards-approved.txt cards-consumed.txt; do
  copy_tree "$DATA_DIR/$f" "$f"
done
[ -d "$DATA_DIR/cards-users" ] && cp -a "$DATA_DIR/cards-users" "$DEST_BOT/"
[ -d "$DATA_DIR/debug" ] && cp -a "$DATA_DIR/debug" "$DEST_BOT/"
[ -d "$DATA_DIR/logs" ] && cp -a "$DATA_DIR/logs" "$DEST_BOT/"
[ -d "$DATA_DIR/backups" ] && cp -a "$DATA_DIR/backups" "$DEST_BOT/"
for f in run.sh stop.sh clear.sh backup.sh restore.sh bot.log automation.log admin.log; do
  copy_tree "$DATA_DIR/$f" "$f"
done
for f in bot.pid automation.pid admin.pid; do
  copy_tree "$DATA_DIR/$f" "$f"
done

echo "[3/7] PKI / snapshots legados em XDG_DATA_HOME…"
[ -d "$ROOT/pki" ] && cp -a "$ROOT/pki" "$OUT_DIR/data/"
[ -d "$ROOT/linkclaro-bot.bak-aug31" ] && cp -a "$ROOT/linkclaro-bot.bak-aug31" "$OUT_DIR/data/"
[ -f "$ROOT/mimeapps.list" ] && cp -a "$ROOT/mimeapps.list" "$OUT_DIR/data/"

echo "[4/7] Exports JSON (conferência legível)…"
sqlite3 -header -json "$DEST_BOT/numbers.db" \
  "SELECT msisdn, link, valores, status, error, scanned_at FROM numbers ORDER BY scanned_at DESC;" \
  > "$OUT_DIR/exports/numbers.json" 2>/dev/null || echo '[]' > "$OUT_DIR/exports/numbers.json"

sqlite3 -header -json "$DEST_BOT/admin.db" \
  "SELECT id, created_at, chat_id, username, login_msisdn, target_msisdn, product_name, product_value_cents, card_bin, card_last4, status, gate_code, gate_message, mode, duration_ms FROM recharge_events ORDER BY created_at DESC;" \
  > "$OUT_DIR/exports/recharge-events.json" 2>/dev/null || echo '[]' > "$OUT_DIR/exports/recharge-events.json"

sqlite3 -header -json "$DEST_BOT/admin.db" \
  "SELECT chat_id, username, first_name, last_name, allowed, is_admin, first_seen, last_seen, message_count FROM telegram_users ORDER BY last_seen DESC;" \
  > "$OUT_DIR/exports/telegram-users.json" 2>/dev/null || echo '[]' > "$OUT_DIR/exports/telegram-users.json"

for tbl in user_balances balance_ledger pix_deposits audit_log bot_settings; do
  if sqlite3 "$DEST_BOT/admin.db" "SELECT name FROM sqlite_master WHERE type='table' AND name='$tbl';" | grep -q "$tbl"; then
    sqlite3 -header -json "$DEST_BOT/admin.db" "SELECT * FROM $tbl;" > "$OUT_DIR/exports/${tbl}.json" 2>/dev/null || true
  fi
done

echo "[5/7] Empacotando código (git HEAD scanner + estado do repo)…"
git -C "$WORKSPACE" archive --format=tar.gz -o "$OUT_DIR/code/scanner.tar.gz" HEAD:scanner 2>/dev/null || {
  tar czf "$OUT_DIR/code/scanner.tar.gz" -C "$WORKSPACE" scanner
}
git -C "$WORKSPACE" rev-parse HEAD > "$OUT_DIR/code/git-commit.txt" 2>/dev/null || true
git -C "$WORKSPACE" branch --show-current > "$OUT_DIR/code/git-branch.txt" 2>/dev/null || true
git -C "$WORKSPACE" status --short > "$OUT_DIR/code/git-status.txt" 2>/dev/null || true

COMMIT="$(cat "$OUT_DIR/code/git-commit.txt" 2>/dev/null || echo unknown)"
BRANCH="$(cat "$OUT_DIR/code/git-branch.txt" 2>/dev/null || echo unknown)"
PENDING="$(find "$DEST_BOT/cards-users" -name 'cards-pending.txt' -exec cat {} + 2>/dev/null | wc -l || echo 0)"
APPROVED="$(find "$DEST_BOT/cards-users" -name 'cards-approved.txt' -exec cat {} + 2>/dev/null | wc -l || echo 0)"
CONSUMED="$(find "$DEST_BOT/cards-users" -name 'cards-consumed.txt' -exec cat {} + 2>/dev/null | wc -l || echo 0)"
LEG_PENDING="0"
[ -f "$DEST_BOT/cards-pending.txt" ] && LEG_PENDING="$(wc -l < "$DEST_BOT/cards-pending.txt")"
NUMBERS="$(sqlite3 "$DEST_BOT/numbers.db" 'SELECT COUNT(*) FROM numbers;' 2>/dev/null || echo 0)"
EVENTS="$(sqlite3 "$DEST_BOT/admin.db" 'SELECT COUNT(*) FROM recharge_events;' 2>/dev/null || echo 0)"
USERS="$(sqlite3 "$DEST_BOT/admin.db" 'SELECT COUNT(*) FROM telegram_users;' 2>/dev/null || echo 0)"
DEBUG_COUNT="$(find "$DEST_BOT/debug" -type f 2>/dev/null | wc -l || echo 0)"
LOG_BYTES="$(du -sb "$DEST_BOT/logs" 2>/dev/null | awk '{print $1}' || echo 0)"
FILE_LIST="$(find "$OUT_DIR" -type f | wc -l)"

cat > "$OUT_DIR/manifest.json" <<EOF
{
  "created_at_utc": "$STAMP",
  "hostname": "$(hostname 2>/dev/null || echo unknown)",
  "public_ip_hint": "$(curl -sS --max-time 2 ifconfig.me 2>/dev/null || echo unknown)",
  "xdg_data_home": "$ROOT",
  "git_commit": "$COMMIT",
  "git_branch": "$BRANCH",
  "counts": {
    "cards_pending_users_tree": $PENDING,
    "cards_approved_users_tree": $APPROVED,
    "cards_consumed_users_tree": $CONSUMED,
    "cards_pending_legacy_root": $LEG_PENDING,
    "numbers_logins": $NUMBERS,
    "recharge_events": $EVENTS,
    "telegram_users": $USERS,
    "debug_files": $DEBUG_COUNT,
    "log_bytes": $LOG_BYTES,
    "files_in_backup": $FILE_LIST
  }
}
EOF

find "$OUT_DIR" -type f | sort > "$OUT_DIR/FILES.txt"

cat > "$OUT_DIR/RESTORE.md" <<'EOF'
# Restaurar backup completo

## 1. Extrair
```bash
tar xzf cloud-backup-YYYYMMDD-HHMMSS.tar.gz -C /tmp/restore
cd /tmp/restore/cloud-backup-YYYYMMDD-HHMMSS
```

## 2. Dados do bot
```bash
export XDG_DATA_HOME="$HOME/.local/share/cloud-bot-home"
mkdir -p "$XDG_DATA_HOME/linkclaro-bot"
rsync -a data/linkclaro-bot/ "$XDG_DATA_HOME/linkclaro-bot/"
# Ou copiar manualmente .env, *.db, cards-users/, logs/, debug/
[ -d data/pki ] && cp -a data/pki "$XDG_DATA_HOME/"
chmod 600 "$XDG_DATA_HOME/linkclaro-bot/.env"
```

## 3. Código
```bash
mkdir -p /workspace/scanner
tar xzf code/scanner.tar.gz -C /workspace
cd /workspace/scanner && npm ci
```

## 4. Serviços
Pare o bot antigo antes (conflito Telegram polling).
```bash
export XDG_DATA_HOME="$HOME/.local/share/cloud-bot-home"
bash /workspace/scanner/cloud-start-services.sh
```

Ver `manifest.json`, `FILES.txt` e `exports/` para conferência.
EOF

echo "[6/7] Criando arquivo comprimido…"
mkdir -p "$WORKSPACE/backups"
tar czf "$ARCHIVE" -C "$WORKSPACE/backups" "cloud-backup-$STAMP"
sha256sum "$ARCHIVE" | tee "$ARCHIVE.sha256"
cp -f "$ARCHIVE" "/tmp/$(basename "$ARCHIVE")" 2>/dev/null || true
cp -f "$ARCHIVE.sha256" "/tmp/$(basename "$ARCHIVE").sha256" 2>/dev/null || true

echo "[7/7] Backup local rápido (backup-appdata)…"
if [ -x "$DATA_DIR/backup.sh" ]; then
  bash "$DATA_DIR/backup.sh" || bash "$WORKSPACE/scanner/backup-appdata.sh"
else
  XDG_DATA_HOME="$ROOT" bash "$WORKSPACE/scanner/backup-appdata.sh"
fi

echo "[offsite] Tentativa de cópia fora da nuvem…"
XDG_DATA_HOME="$ROOT" WORKSPACE="$WORKSPACE" bash "$WORKSPACE/scanner/cloud-backup-offsite.sh" "$ARCHIVE" || true

echo "Pronto."
ls -lh "$ARCHIVE"
echo "SHA256=$(sha256sum "$ARCHIVE" | awk '{print $1}')"
echo "DIR=$OUT_DIR"
echo ""
echo "IMPORTANTE: o .tar.gz fica NO DISCO DA NUVEM até você baixar ou enviar off-site (VPS_PASS)."
