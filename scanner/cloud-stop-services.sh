#!/bin/bash
TMUX="tmux -f /exec-daemon/tmux.portal.conf"
for s in cloud-telegram-bot cloud-automation cloud-admin; do
  $TMUX kill-session -t "$s" 2>/dev/null || true
done
echo "Serviços nuvem parados."
