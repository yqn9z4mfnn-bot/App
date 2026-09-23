"""Consulta /health da automação (Edge) para distinguir progress real vs mensagem fantasma."""
import json
import os
import time
import urllib.error
import urllib.request
from datetime import timezone

AUTOMATION_URL = os.environ.get("AUTOMATION_API_URL", "http://127.0.0.1:3000").rstrip("/")
ZOMBIE_PROGRESS_SEC = int(os.environ.get("FACIL_ZOMBIE_PROGRESS_SEC", "120"))

_cache = {"at": 0.0, "alive": None}


def automation_alive_sessions(*, cache_sec=5):
    """Sessões Edge vivas; None se /health indisponível."""
    now = time.time()
    if now - _cache["at"] < cache_sec and _cache["alive"] is not None:
        return _cache["alive"]
    alive = None
    try:
        req = urllib.request.Request(
            f"{AUTOMATION_URL}/health",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode())
        alive = int(data.get("aliveSessions") or 0)
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError, TimeoutError):
        alive = None
    _cache["at"] = now
    _cache["alive"] = alive
    return alive


def message_age_sec(msg, *, now=None):
    if not msg or not getattr(msg, "date", None):
        return None
    d = msg.date
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    ref = now if now is not None else time.time()
    if isinstance(ref, (int, float)):
        return ref - d.timestamp()
    return (ref - d).total_seconds()


def progress_is_zombie(msg, *, now=None, min_age_sec=None):
    """
    Progress no chat do bot sem sessão Edge ativa e mensagem antiga → não bloqueia fila.
    Se /health falhar, conservador (não trata como fantasma).
    """
    alive = automation_alive_sessions()
    if alive is None or alive > 0:
        return False
    age = message_age_sec(msg, now=now)
    if age is None:
        return False
    threshold = ZOMBIE_PROGRESS_SEC if min_age_sec is None else min_age_sec
    return age >= threshold
