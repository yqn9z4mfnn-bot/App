#!/usr/bin/env python3
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import automation_health as ah


def test_progress_is_zombie_when_idle_and_old(monkeypatch):
    monkeypatch.setattr(ah, "automation_alive_sessions", lambda **_: 0)
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    msg = SimpleNamespace(date=old)
    assert ah.progress_is_zombie(msg, min_age_sec=120) is True


def test_progress_not_zombie_when_edge_alive(monkeypatch):
    monkeypatch.setattr(ah, "automation_alive_sessions", lambda **_: 1)
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    msg = SimpleNamespace(date=old)
    assert ah.progress_is_zombie(msg) is False


def test_progress_not_zombie_when_health_unknown(monkeypatch):
    monkeypatch.setattr(ah, "automation_alive_sessions", lambda **_: None)
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    msg = SimpleNamespace(date=old)
    assert ah.progress_is_zombie(msg) is False
