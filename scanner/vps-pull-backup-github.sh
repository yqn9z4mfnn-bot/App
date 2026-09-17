#!/bin/bash
# Rode NA VPS (147.93.13.252) — baixa backup criptografado do GitHub (repo público).
set -euo pipefail

REPO="${BACKUP_GITHUB_REPO:-yqn9z4mfnn-bot/App}"
BRANCH="${BACKUP_GITHUB_BRANCH:-cursor/claro-api-map-2a06}"
STAMP="${1:-20260917-213851}"
REMOTE_DIR="${BACKUP_REMOTE_DIR:-/root/backups/linkclaro-cloud}"
BASE="cloud-backup-${STAMP}"

mkdir -p "$REMOTE_DIR"
cd "$REMOTE_DIR"

RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}/backups-published"
for f in "${BASE}.tar.gz.enc" "${BASE}.tar.gz.enc.sha256" README.md; do
  echo "Baixando $f …"
  curl -fsSL -o "$f" "$RAW/$f"
done

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c "${BASE}.tar.gz.enc.sha256"
fi

chmod 700 "$REMOTE_DIR"
chmod 600 "${BASE}.tar.gz.enc" 2>/dev/null || true
ls -lh "$REMOTE_DIR"

echo ""
echo "OK: $REMOTE_DIR/${BASE}.tar.gz.enc"
echo "Descriptografar (senha informada pelo admin, não está no Git):"
echo "  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \\"
echo "    -in ${BASE}.tar.gz.enc -out ${BASE}.tar.gz"
