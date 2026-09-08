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


TERMINAL_KINDS = frozenset({"approved", "denied", "3ds", "fail", "fail_login"})

# Títulos/hints que o bot edita enquanto a recarga ainda corre — NÃO são erro.
PROGRESS_RE = re.compile(
    r"Preparando|Processando|Recarga autom[aá]tica|Conferindo|"
    r"Nova tentativa|__Processando__|"
    r"Gerando login|Verificando fila|Aguardando checkout|"
    r"Aguardando navegador|Consultando saldo|Limpando cart[oõ]es|"
    r"Pegando cart[aã]o|Cart[aã]o da fila|Lendo saldo|"
    r"Confirmando no hist[oó]rico|Fila: aguardando|Limpeza pulada|"
    r"Buscando valores|Rede inst[aá]vel|Login pronto|Iniciando recarga|"
    r"Falha no login|Too Many Requests",
    re.I,
)

# Só estes erros encerram a espera. 429 / Falha no login o bot ainda retenta.
FINAL_FAIL_RE = re.compile(
    r"Falha na automa[cç][aã]o|Erro na recarga|Erro no retry|"
    r"Fila vazia|Valor indisponível|Sem valores",
    re.I,
)


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
    if FINAL_FAIL_RE.search(t):
        return "fail"
    if PROGRESS_RE.search(t):
        return "progress"
    if re.search(r"❌|FALH|ERRO", t, re.I):
        return "fail"
    return "other"


def is_terminal_kind(kind):
    return kind in TERMINAL_KINDS


def is_actionable_response(text):
    return is_terminal_kind(classify_bot_response(text))


def pick_bot_state(rows):
    """rows: mensagens do alvo, mais recente primeiro. APROVADA vence; senão a mais nova."""
    for kind, text in rows:
        if kind == "approved":
            return kind, text
    if rows:
        return rows[0]
    return "idle", ""
