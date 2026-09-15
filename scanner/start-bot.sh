#!/bin/bash
# Redireciona para instalação em appdata (~/.local/share/linkclaro-bot)
exec bash "$(dirname "$0")/install-appdata.sh" "$@"