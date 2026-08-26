#!/bin/bash
cd "$(dirname "$0")"
set -a
[ -f .env ] && source .env
set +a
exec node telegram-bot.mjs
