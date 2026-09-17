#!/bin/bash
# Envia o .tar.gz de migração para fora da nuvem (VPS Hostinger ou destino scp).
# Uso:
#   VPS_PASS='...' bash scanner/cloud-backup-offsite.sh
#   bash scanner/cloud-backup-offsite.sh /caminho/cloud-backup-....tar.gz
set -euo pipefail

ARCHIVE="${1:-}"
WORKSPACE="${WORKSPACE:-/workspace}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share/cloud-bot-home}/linkclaro-bot"

if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$(ls -t "$WORKSPACE"/backups/cloud-backup-*.tar.gz 2>/dev/null | head -1)"
fi
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Nenhum cloud-backup-*.tar.gz encontrado. Rode cloud-migration-backup.sh antes."
  exit 1
fi

SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
BASE="$(basename "$ARCHIVE")"

# Cópia redundante dentro dos dados do bot (mesmo disco, mas junto do app)
mkdir -p "$DATA_DIR/backups/offsite-mirror"
cp -f "$ARCHIVE" "$DATA_DIR/backups/offsite-mirror/$BASE"
cp -f "${ARCHIVE}.sha256" "$DATA_DIR/backups/offsite-mirror/${BASE}.sha256" 2>/dev/null || \
  sha256sum "$ARCHIVE" > "$DATA_DIR/backups/offsite-mirror/${BASE}.sha256"
echo "Espelho local: $DATA_DIR/backups/offsite-mirror/$BASE"

VPS_HOST="${VPS_HOST:-root@147.93.13.252}"
REMOTE_DIR="${BACKUP_REMOTE_DIR:-/root/backups/linkclaro-cloud}"

if [ -n "${BACKUP_SCP_TARGET:-}" ]; then
  echo "Enviando via BACKUP_SCP_TARGET…"
  scp -o StrictHostKeyChecking=accept-new "$ARCHIVE" "${ARCHIVE}.sha256" "$BACKUP_SCP_TARGET"
  echo "Off-site OK → $BACKUP_SCP_TARGET"
  exit 0
fi

if [ -z "${VPS_PASS:-}" ]; then
  echo ""
  echo "⚠️  VPS_PASS / BACKUP_SCP_TARGET não definidos — backup NÃO saiu da nuvem."
  echo "    Baixe manualmente: $ARCHIVE"
  echo "    SHA256: $SHA"
  echo "    Ou: VPS_PASS='senha-root-vps' bash $0"
  exit 0
fi

if ! command -v sshpass >/dev/null 2>&1; then
  echo "Instale sshpass ou use BACKUP_SCP_TARGET com chave SSH."
  exit 1
fi

echo "Enviando para $VPS_HOST:$REMOTE_DIR …"
sshpass -p "$VPS_PASS" ssh -o StrictHostKeyChecking=accept-new "$VPS_HOST" "mkdir -p '$REMOTE_DIR'"
sshpass -p "$VPS_PASS" scp -o StrictHostKeyChecking=accept-new \
  "$ARCHIVE" "${ARCHIVE}.sha256" \
  "$VPS_HOST:$REMOTE_DIR/"
sshpass -p "$VPS_PASS" ssh -o StrictHostKeyChecking=accept-new "$VPS_HOST" \
  "ls -lh '$REMOTE_DIR/$BASE' && head -1 '$REMOTE_DIR/${BASE}.sha256'"

echo "Off-site OK → $VPS_HOST:$REMOTE_DIR/$BASE"
echo "SHA256=$SHA"
