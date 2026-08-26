#!/bin/bash
# Monitora sessões da automação — print quando travar no mesmo passo.
set -euo pipefail

API="${AUTOMATION_API_URL:-http://127.0.0.1:3000}"
OUT_DIR="${STUCK_SCREENSHOT_DIR:-/opt/cursor/artifacts/screenshots/stuck}"
POLL_SEC="${STUCK_POLL_SEC:-8}"
# Segundos parado no mesmo passo antes de considerar travado
THRESHOLD_VALOR=25
THRESHOLD_CHECKOUT=35
THRESHOLD_SMART=50
THRESHOLD_FILL=40
THRESHOLD_DEFAULT=45

mkdir -p "$OUT_DIR"
LOG="/tmp/monitor-stuck.log"
declare -A LAST_SHOT

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG"; }

threshold_for_step() {
  case "$1" in
    valor) echo "$THRESHOLD_VALOR" ;;
    aguardando_checkout) echo "$THRESHOLD_CHECKOUT" ;;
    smart_checkout) echo "$THRESHOLD_SMART" ;;
    fill_pan|claim_pam) echo "$THRESHOLD_FILL" ;;
    *) echo "$THRESHOLD_DEFAULT" ;;
  esac
}

log "Monitor iniciado API=$API dir=$OUT_DIR poll=${POLL_SEC}s"

while true; do
  if ! curl -sf "$API/health" >/dev/null 2>&1; then
    log "automação offline — aguardando…"
    sleep "$POLL_SEC"
    continue
  fi

  SESSIONS_JSON=$(curl -sf "$API/api/sessions" 2>/dev/null || echo "{}")
  COUNT=$(echo "$SESSIONS_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('sessions') or []))" 2>/dev/null || echo 0)

  if [ "$COUNT" = "0" ]; then
    sleep "$POLL_SEC"
    continue
  fi

  echo "$SESSIONS_JSON" | python3 -c "
import json, sys, os
d = json.load(sys.stdin)
for s in d.get('sessions') or []:
    print('|'.join([
        s.get('sessionId',''),
        s.get('step',''),
        str(s.get('idleForSeconds', 0)),
        s.get('accessNumber',''),
        (s.get('stepLabel') or '')[:80],
        s.get('status',''),
    ]))
" 2>/dev/null | while IFS='|' read -r SID STEP IDLE MSISDN LABEL STATUS; do
    [ -z "$SID" ] && continue
    TH=$(threshold_for_step "$STEP")
    if [ "${IDLE:-0}" -lt "$TH" ]; then
      continue
    fi
    KEY="${SID}:${STEP}"
    NOW=$(date +%s)
    LAST=${LAST_SHOT[$KEY]:-0}
    if [ $((NOW - LAST)) -lt 120 ]; then
      continue
    fi
    STAMP=$(date +%Y%m%d_%H%M%S)
    FILE="$OUT_DIR/stuck_${MSISDN}_${STEP}_${STAMP}.png"
    if curl -sf "$API/api/session/$SID/screenshot" -o "$FILE" 2>/dev/null; then
      LAST_SHOT[$KEY]=$NOW
      log "PRINT travado step=$STEP idle=${IDLE}s msisdn=$MSISDN → $FILE"
      echo "$LABEL" > "${FILE%.png}.txt"
    else
      log "falha screenshot session=$SID step=$STEP"
    fi
  done

  sleep "$POLL_SEC"
done
