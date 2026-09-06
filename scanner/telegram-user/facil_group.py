"""Helpers grupo Fácil RECARGAS + bot Linkclaro."""
import re

GROUP_ID = 2841351530
BOT_USERNAME = "Linkclarotesbot"

PAYLOAD_RE = re.compile(r"`(\d{10,11}\|[A-Za-z]+\|\d+)`")
PEDIDO_RE = re.compile(r"`([a-f0-9]{20,})`")


def parse_payload(text):
    m = PAYLOAD_RE.search(text or "")
    return m.group(1) if m else None


def payload_target(payload):
    return (payload or "").split("|")[0].strip()


def response_matches_target(text, target):
    """Resposta do bot deve mencionar o MSISDN do pedido atual."""
    if not target:
        return True
    digits = re.sub(r"\D", "", str(target))
    if not digits:
        return True
    blob = re.sub(r"\D", "", (text or "").replace("`", ""))
    return digits in blob


def parse_pedido_id(text):
    m = PEDIDO_RE.search(text or "")
    return m.group(1) if m else None


def is_confirm_prompt(text):
    t = text or ""
    return "Tem certeza" in t and "FEITA" in t.upper()


def is_feita_final(text):
    t = text or ""
    return bool(re.search(r"Status:\s*✅\s*\*\*Feita\*\*|Status:\s*✅\s*Feita", t, re.I))


def classify_bot_response(text):
    t = text or ""
    if re.search(r"✅\s*\*\*APROVADA\*\*|APROVADA", t, re.I):
        return "approved"
    if re.search(r"Validação 3DS|3DS|\bVBV\b", t, re.I):
        return "3ds"
    if re.search(r"NEGAD|RECUSAD|CARTAO BLOQUEADO|CARTÃO BLOQUEADO", t, re.I):
        return "denied"
    if re.search(r"Não iniciou|NAO iniciou", t, re.I):
        return "fail_login"
    if re.search(r"❌|FALH|ERRO", t, re.I) and not re.search(
        r"aguardando checkout|aguardando navegador|gerando login|consultando saldo",
        t,
        re.I,
    ):
        return "fail"
    if re.search(
        r"Gerando login|Verificando fila do navegador|Aguardando checkout|"
        r"Aguardando navegador|Consultando saldo|__Processando__|"
        r"Fila: aguardando",
        t,
        re.I,
    ):
        return "progress"
    if re.search(r"Recarga automática", t, re.I) and re.search(
        r"Gerando login|Verificando fila|Aguardando|Processando", t, re.I
    ):
        return "progress"
    return "other"


def is_actionable_response(text):
    return classify_bot_response(text) != "progress"
