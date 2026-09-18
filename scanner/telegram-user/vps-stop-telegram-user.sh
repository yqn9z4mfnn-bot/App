#!/bin/bash
TMUX="${TMUX_CMD:-tmux -S /tmp/tmux-0/default}"
$TMUX kill-session -t tg-user 2>/dev/null || true
echo "tg-user parado (sessão .session preservada)"
