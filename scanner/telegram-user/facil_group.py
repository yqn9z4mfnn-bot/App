"""Helpers grupo Fácil RECARGAS + bot Linkclaro."""
import re

GROUP_ID = 2841351530
BOT_USERNAME = "Linkclarotesbot"

PAYLOAD_RE = re.compile(r"`(\d{10,11}\|[A-Za-z]+\|\d+)`")
PEDIDO_RE = re.compile(r"`([a-f0-9]{20,})`")


def parse_payload(text):
    m = PAYLOAD_RE.search(text or "")
    return m.group(1) if m else None


def parse_pedido_id(text):
    m = PEDIDO_RE.search(text or "")
    return m.group(1) if m else None


def classify_bot_response(text):
    t = text or ""
    if re.search(r"✅\s*\*\*APROVADA\*\*|APROVADA", t, re.I):
        return "approved"
    if re.search(r"Validação 3DS|3DS", t, re.I):
        return "3ds"
    if re.search(r"NEGAD|RECUSAD|CARTAO BLOQUEADO|CARTÃO BLOQUEADO", t, re.I):
        return "denied"
    if re.search(r"Não iniciou|NAO iniciou", t, re.I):
        return "fail_login"
    if re.search(r"❌|FALH|ERRO", t, re.I) and not re.search(r"aguardando|fila|processando", t, re.I):
        return "fail"
    if re.search(
        r"Recarga automática|Gerando login|Verificando fila|Processando|"
        r"Aguardando checkout|Aguardando navegador|Fila:|checkout",
        t,
        re.I,
    ):
        return "progress"
    return "other"


def is_actionable_response(text):
    return classify_bot_response(text) in ("approved", "3ds", "denied", "fail_login", "fail")
