#!/bin/bash
# Backup completo para migrar a VM (dados + código + exports legíveis).
set -euo pipefail

ROOT="${XDG_DATA_HOME:-$HOME/.local/share/cloud-bot-home}"
DATA_DIR="$ROOT/linkclaro-bot"
WORKSPACE="${WORKSPACE:-/workspace}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="$WORKSPACE/backups/cloud-backup-$STAMP"
ARCHIVE="$WORKSPACE/backups/cloud-backup-$STAMP.tar.gz"

mkdir -p "$OUT_DIR/data" "$OUT_DIR/code" "$OUT_DIR/exports" "$OUT_DIR/data/linkclaro-bot"

echo "[1/6] Checkpoint SQLite…"
sqlite3 "$DATA_DIR/admin.db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
sqlite3 "$DATA_DIR/numbers.db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
sqlite3 "$DATA_DIR/admin.db" ".backup '$OUT_DIR/data/linkclaro-bot/admin.db'"
sqlite3 "$DATA_DIR/numbers.db" ".backup '$OUT_DIR/data/linkclaro-bot/numbers.db'"

echo "[2/6] Copiando dados (env, filas, reservas, debug, pki)…"
cp -a "$DATA_DIR/.env" "$OUT_DIR/data/linkclaro-bot/"
for f in cards-pending.txt cards-approved.txt cards-consumed.txt cards-reserved.json; do
  [ -f "$DATA_DIR/$f" ] && cp -a "$DATA_DIR/$f" "$OUT_DIR/data/linkclaro-bot/"
done
[ -d "$DATA_DIR/debug" ] && cp -a "$DATA_DIR/debug" "$OUT_DIR/data/linkclaro-bot/"
[ -d "$ROOT/pki" ] && cp -a "$ROOT/pki" "$OUT_DIR/data/"

echo "[3/6] Exports legíveis (logins, recargas, usuários)…"
sqlite3 -header -json "$OUT_DIR/data/linkclaro-bot/numbers.db" \
  "SELECT msisdn, link, valores, status, error, scanned_at FROM numbers ORDER BY scanned_at DESC;" \
  > "$OUT_DIR/exports/numbers.json"
sqlite3 -header -json "$OUT_DIR/data/linkclaro-bot/admin.db" \
  "SELECT id, created_at, chat_id, username, login_msisdn, target_msisdn, product_name, product_value_cents, card_bin, card_last4, status, gate_code, gate_message, mode, duration_ms FROM recharge_events ORDER BY created_at DESC;" \
  > "$OUT_DIR/exports/recharge-events.json"
sqlite3 -header -json "$OUT_DIR/data/linkclaro-bot/admin.db" \
  "SELECT chat_id, username, first_name, last_name, allowed, is_admin, first_seen, last_seen, message_count FROM telegram_users ORDER BY last_seen DESC;" \
  > "$OUT_DIR/exports/telegram-users.json"

echo "[4/6] Empacotando código scanner…"
git -C "$WORKSPACE" archive --format=tar.gz -o "$OUT_DIR/code/scanner.tar.gz" HEAD:scanner

COMMIT="$(git -C "$WORKSPACE" rev-parse HEAD)"
BRANCH="$(git -C "$WORKSPACE" branch --show-current 2>/dev/null || echo unknown)"
PENDING="$(wc -l < "$OUT_DIR/data/linkclaro-bot/cards-pending.txt" 2>/dev/null || echo 0)"
APPROVED="$(wc -l < "$OUT_DIR/data/linkclaro-bot/cards-approved.txt" 2>/dev/null || echo 0)"
CONSUMED="$(wc -l < "$OUT_DIR/data/linkclaro-bot/cards-consumed.txt" 2>/dev/null || echo 0)"
NUMBERS="$(sqlite3 "$OUT_DIR/data/linkclaro-bot/numbers.db" 'SELECT COUNT(*) FROM numbers;')"
EVENTS="$(sqlite3 "$OUT_DIR/data/linkclaro-bot/admin.db" 'SELECT COUNT(*) FROM recharge_events;')"
USERS="$(sqlite3 "$OUT_DIR/data/linkclaro-bot/admin.db" 'SELECT COUNT(*) FROM telegram_users;')"
DEBUG_COUNT="$(find "$OUT_DIR/data/linkclaro-bot/debug" -type f 2>/dev/null | wc -l || echo 0)"

cat > "$OUT_DIR/manifest.json" <<EOF
{
  "created_at_utc": "$STAMP",
  "hostname": "$(hostname 2>/dev/null || echo unknown)",
  "xdg_data_home": "$ROOT",
  "git_commit": "$COMMIT",
  "git_branch": "$BRANCH",
  "counts": {
    "cards_pending": $PENDING,
    "cards_approved": $APPROVED,
    "cards_consumed": $CONSUMED,
    "numbers_logins": $NUMBERS,
    "recharge_events": $EVENTS,
    "telegram_users": $USERS,
    "debug_files": $DEBUG_COUNT
  },
  "includes": [
    "data/linkclaro-bot/.env",
    "data/linkclaro-bot/admin.db",
    "data/linkclaro-bot/numbers.db",
    "data/linkclaro-bot/cards-pending.txt",
    "data/linkclaro-bot/cards-approved.txt",
    "data/linkclaro-bot/cards-consumed.txt",
    "data/linkclaro-bot/cards-reserved.json",
    "data/linkclaro-bot/debug/",
    "data/pki/",
    "exports/numbers.json",
    "exports/recharge-events.json",
    "exports/telegram-users.json",
    "code/scanner.tar.gz"
  ]
}
EOF

cat > "$OUT_DIR/RESTORE.md" <<'EOF'
# Restaurar backup na nova VM

## 1. Extrair
```bash
tar xzf cloud-backup-YYYYMMDD-HHMMSS.tar.gz -C /tmp/restore
cd /tmp/restore/cloud-backup-YYYYMMDD-HHMMSS
```

## 2. Dados do bot
```bash
export XDG_DATA_HOME="$HOME/.local/share/cloud-bot-home"
mkdir -p "$XDG_DATA_HOME/linkclaro-bot"
cp -a data/linkclaro-bot/.env "$XDG_DATA_HOME/linkclaro-bot/"
cp -a data/linkclaro-bot/*.db "$XDG_DATA_HOME/linkclaro-bot/"
cp -a data/linkclaro-bot/cards-*.txt data/linkclaro-bot/cards-reserved.json "$XDG_DATA_HOME/linkclaro-bot/"
cp -a data/linkclaro-bot/debug "$XDG_DATA_HOME/linkclaro-bot/" 2>/dev/null || true
[ -d data/pki ] && cp -a data/pki "$XDG_DATA_HOME/"
chmod 600 "$XDG_DATA_HOME/linkclaro-bot/.env"
```

## 3. Código
```bash
mkdir -p /workspace/scanner
tar xzf code/scanner.tar.gz -C /workspace
cd /workspace/scanner && npm ci
bash install-appdata.sh   # se necessário
```

## 4. Subir serviços
Pare o bot antigo na VM anterior antes de iniciar aqui (conflito Telegram).
```bash
export XDG_DATA_HOME="$HOME/.local/share/cloud-bot-home"
bash "$XDG_DATA_HOME/linkclaro-bot/run.sh"  # ou equivalente
```

## Conteúdo
- **numbers.db** — logins Claro (MSISDN, links, valores)
- **admin.db** — histórico recargas, usuários Telegram, audit
- **cards-*.txt** — fila pendente, aprovados, consumidos (VBV/negada)
- **cards-reserved.json** — reservas ativas
- **.env** — token Telegram e variáveis
- **pki/** — certificados NSS do browser
- **exports/** — JSON legível para conferência
EOF

echo "[5/6] Criando arquivo…"
tar czf "$ARCHIVE" -C "$WORKSPACE/backups" "cloud-backup-$STAMP"
sha256sum "$ARCHIVE" | tee "$ARCHIVE.sha256"
cp -f "$ARCHIVE" "/tmp/$(basename "$ARCHIVE")" 2>/dev/null || true

echo "[6/6] Pronto"
ls -lh "$ARCHIVE"
echo "SHA256=$(sha256sum "$ARCHIVE" | awk '{print $1}')"
