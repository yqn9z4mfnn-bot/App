#!/usr/bin/env python3
"""Monitora sessões — salva PNG quando parar no mesmo passo."""
import json
import os
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = os.environ.get("AUTOMATION_API_URL", "http://127.0.0.1:3000")
OUT_DIR = Path(os.environ.get("STUCK_SCREENSHOT_DIR", "/opt/cursor/artifacts/screenshots/stuck"))
POLL_SEC = int(os.environ.get("STUCK_POLL_SEC", "8"))
LOG = Path("/tmp/monitor-stuck.log")

THRESHOLDS = {
    "valor": 25,
    "aguardando_checkout": 35,
    "smart_checkout": 50,
    "fill_pan": 40,
    "claim_pam": 40,
}
DEFAULT_THRESHOLD = 45
DEDUP_SEC = 120

last_shot = {}


def log(msg: str) -> None:
    line = f"[{datetime.now(timezone.utc).isoformat()}] {msg}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read().decode())


def save_png(url: str, path: Path) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            path.write_bytes(r.read())
        return True
    except Exception as e:
        log(f"falha screenshot {url}: {e}")
        return False


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    log(f"Monitor iniciado API={API} dir={OUT_DIR} poll={POLL_SEC}s")

    while True:
        try:
            get_json(f"{API}/health")
        except Exception:
            log("automação offline — aguardando…")
            time.sleep(POLL_SEC)
            continue

        try:
            data = get_json(f"{API}/api/sessions")
        except Exception as e:
            log(f"erro /api/sessions: {e}")
            time.sleep(POLL_SEC)
            continue

        for s in data.get("sessions") or []:
            sid = s.get("sessionId") or ""
            step = s.get("step") or ""
            idle = int(s.get("idleForSeconds") or 0)
            msisdn = s.get("accessNumber") or "unknown"
            label = s.get("stepLabel") or ""
            th = THRESHOLDS.get(step, DEFAULT_THRESHOLD)
            if idle < th:
                continue

            key = f"{sid}:{step}"
            now = time.time()
            if now - last_shot.get(key, 0) < DEDUP_SEC:
                continue

            stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            png = OUT_DIR / f"stuck_{msisdn}_{step}_{stamp}.png"
            if save_png(f"{API}/api/session/{sid}/screenshot", png):
                last_shot[key] = now
                (png.with_suffix(".txt")).write_text(label, encoding="utf-8")
                log(f"PRINT travado step={step} idle={idle}s msisdn={msisdn} → {png}")

        time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
