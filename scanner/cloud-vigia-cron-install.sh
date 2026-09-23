#!/bin/bash
# Ativa vigia periódico na VM (cron se existir; senão tmux cloud-vigia-daemon). Não altera .env/proxy.
set -euo pipefail
APP_DIR="/workspace/scanner"
DATA_DIR="/home/ubuntu/.local/share/cloud-bot-home/linkclaro-bot"
unset TMUX TMUX_PANE
TMUX_CMD="tmux -f /exec-daemon/tmux.portal.conf"
MARKER="cloud-vigia-check.sh"
CRON_LINE="*/15 * * * * bash $APP_DIR/cloud-vigia-check.sh >> $DATA_DIR/logs/cloud-vigia-cron.log 2>&1"

mkdir -p "$DATA_DIR/logs"
chmod +x "$APP_DIR/cloud-vigia-check.sh" "$APP_DIR/cloud-vigia-cron-install.sh" "$APP_DIR/cloud-vigia-daemon.sh" 2>/dev/null || true

if command -v crontab >/dev/null 2>&1; then
  existing="$(crontab -l 2>/dev/null || true)"
  if echo "$existing" | grep -Fq "$MARKER"; then
    echo "Cron vigia já instalado."
  else
    (echo "$existing"; echo "$CRON_LINE") | crontab -
    echo "Cron vigia instalado (a cada 15 min)."
  fi
  crontab -l | grep -F "$MARKER" || true
else
  echo "(crontab indisponível — usando tmux cloud-vigia-daemon)"
  if $TMUX_CMD has-session -t "=cloud-vigia-daemon" 2>/dev/null; then
    echo "Daemon vigia já ativo (tmux cloud-vigia-daemon)."
  else
    $TMUX_CMD new-session -d -s cloud-vigia-daemon -c "$APP_DIR" -- bash -lc "exec $APP_DIR/cloud-vigia-daemon.sh"
    echo "Daemon vigia iniciado (tmux cloud-vigia-daemon, 15 min)."
  fi
fi
