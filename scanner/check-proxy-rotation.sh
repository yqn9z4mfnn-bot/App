#!/bin/bash
# Mostra IPs de saída do proxy (6 req) — confere se está rotacionando.
set -euo pipefail
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/linkclaro-bot"
ENV_FILE="$DATA_DIR/.env"
APP_DIR="$DATA_DIR/app"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
cd "$APP_DIR"
node -e "
import { fetchProxyEgressIp, describeProxy } from './lib/proxy.mjs';
console.log('proxy:', describeProxy() || 'DESLIGADO');
if (!process.env.PROXY_ENABLED || process.env.PROXY_ENABLED === '0') {
  console.error('PROXY_ENABLED=0 — ative com enable-proxy.sh');
  process.exit(1);
}
const ips = [];
for (let i = 1; i <= 6; i++) {
  const ip = await fetchProxyEgressIp({ rotateIp: true });
  ips.push(ip);
  console.log('req' + i, ip);
}
console.log('unique', new Set(ips).size, 'de', ips.length);
"
