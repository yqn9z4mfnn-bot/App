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

mkdir -p "$DATA_DIR/backups/offsite-mirror"
cp -f "$ARCHIVE" "$DATA_DIR/backups/offsite-mirror/$BASE"
cp -f "${ARCHIVE}.sha256" "$DATA_DIR/backups/offsite-mirror/${BASE}.sha256" 2>/dev/null || \
  sha256sum "$ARCHIVE" > "$DATA_DIR/backups/offsite-mirror/${BASE}.sha256"
echo "Espelho local: $DATA_DIR/backups/offsite-mirror/$BASE"

VPS_HOST="${VPS_HOST:-root@147.93.13.252}"
REMOTE_DIR="${BACKUP_REMOTE_DIR:-/root/backups/linkclaro-cloud}"
SSH_KEY="${BACKUP_SSH_KEY:-$HOME/.ssh/linkclaro_vps}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
if [ -f "$SSH_KEY" ]; then
  SSH_OPTS+=(-i "$SSH_KEY" -o IdentitiesOnly=yes)
fi

if [ -n "${BACKUP_SCP_TARGET:-}" ]; then
  echo "Enviando via BACKUP_SCP_TARGET…"
  scp "${SSH_OPTS[@]}" "$ARCHIVE" "${ARCHIVE}.sha256" "$BACKUP_SCP_TARGET"
  echo "Off-site OK → $BACKUP_SCP_TARGET"
  exit 0
fi

PUBLISHED="$WORKSPACE/backups-published"
EXTRA=()
if [ -d "$PUBLISHED" ]; then
  for f in "$PUBLISHED"/*.tar.gz.enc "$PUBLISHED"/*.tar.gz.enc.sha256 "$PUBLISHED"/README.md; do
    [ -f "$f" ] && EXTRA+=("$f")
  done
fi

do_upload() {
  echo "Enviando para $VPS_HOST:$REMOTE_DIR …"
  "$@" ssh "${SSH_OPTS[@]}" "$VPS_HOST" "mkdir -p '$REMOTE_DIR'"
  "$@" scp "${SSH_OPTS[@]}" "$ARCHIVE" "${ARCHIVE}.sha256" "${EXTRA[@]}" "$VPS_HOST:$REMOTE_DIR/"
  "$@" ssh "${SSH_OPTS[@]}" "$VPS_HOST" \
    "chmod 700 '$REMOTE_DIR'; ls -lh '$REMOTE_DIR/$BASE'; head -1 '$REMOTE_DIR/${BASE}.sha256'"
}

if ssh -o BatchMode=yes -o ConnectTimeout=10 "${SSH_OPTS[@]}" "$VPS_HOST" 'echo ok' 2>/dev/null | grep -q ok; then
  do_upload
  echo "Off-site OK (chave SSH) → $VPS_HOST:$REMOTE_DIR/$BASE"
  echo "SHA256=$SHA"
  exit 0
fi

if [ -n "${VPS_PASS:-}" ] && command -v sshpass >/dev/null 2>&1; then
  run_sshpass() { sshpass -p "$VPS_PASS" "$@"; }
  do_upload run_sshpass
  echo "Off-site OK (senha) → $VPS_HOST:$REMOTE_DIR/$BASE"
  echo "SHA256=$SHA"
  exit 0
fi

echo ""
echo "⚠️  Sem acesso SSH à VPS — backup completo (.tar.gz) NÃO enviado."
echo "    Arquivo local: $ARCHIVE"
echo "    SHA256: $SHA"
echo ""
echo "    Opção A (nuvem → VPS): VPS_PASS='senha-root' bash $0"
echo "    Opção B (VPS baixa do GitHub, criptografado):"
echo "      bash /root/App/scanner/vps-pull-backup-github.sh"
echo "    Opção C: adicionar em /root/.ssh/authorized_keys na VPS:"
cat "${SSH_KEY}.pub" 2>/dev/null || true
exit 1
