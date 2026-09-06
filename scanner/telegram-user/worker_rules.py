"""Regras puras do worker Fácil — testáveis sem Telegram."""
import re


def payload_target(payload):
    return (payload or "").split("|")[0].strip()


def decide_next_action(open_orders, current_pedido_id, bot_active_targets=None):
    """
    Decide o próximo passo SEM reivindicar por engano.

    open_orders: lista de dicts {pedido_id, payload, msg_id}
    current_pedido_id: pedido registrado neste worker (ou None)
    bot_active_targets: MSISDNs com progress/approved no bot agora

    Retorna (acao, pedido_id):
      resume — processar esse pedido (já reivindicado por nós / bot ativo nele)
      block  — há pedido aberto; NÃO reivindicar outro
      claim  — grupo limpo; pode reivindicar 1 novo
    """
    bot_active_targets = set(bot_active_targets or [])
    open_ids = [o["pedido_id"] for o in open_orders if o.get("pedido_id")]

    if current_pedido_id and current_pedido_id in open_ids:
        return "resume", current_pedido_id

    if not open_orders:
        return "claim", None

    matches = []
    for o in open_orders:
        target = payload_target(o.get("payload") or "")
        if target and target in bot_active_targets:
            matches.append(o)

    if len(matches) == 1:
        return "resume", matches[0]["pedido_id"]

    return "block", None


def error_fingerprint(kind, text, target):
    """Chave estável do erro neste MSISDN (não mistura com outro número)."""
    t = re.sub(r"\s+", " ", (text or ""))
    t = t.replace("`", "")
    m = re.search(
        r"Falha no login \([^)]+\)|Too Many Requests|CART[AÃ]O BLOQUEADO|"
        r"N[aã]o iniciou|NEGAD\w*|RECUSAD\w*|Validação 3DS",
        t,
        re.I,
    )
    detail = (m.group(0) if m else kind or "erro").strip().lower()
    detail = re.sub(r"\s+", " ", detail)[:80]
    return f"{target}|{kind}|{detail}"


def next_after_bot_result(kind, fingerprint, last_fingerprint):
    """
    approved → close
    1º erro → retry mesmo número após 60s
    2º erro igual (mesmo número já está no fingerprint) → halt, não reivindica
    erro diferente → retry após 60s (streak recomeça)
    """
    if kind == "approved":
        return "close"
    if last_fingerprint and fingerprint == last_fingerprint:
        return "halt"
    return "retry"


def claim_allowed(open_count):
    return open_count == 0


def is_cancel_label(label):
    t = (label or "").strip()
    return "cancelar" in t.lower()


def is_confirm_label(label):
    t = (label or "").strip()
    if is_cancel_label(t):
        return False
    return t == "✅ Confirmar" or t.endswith("Confirmar")


def is_feita_label(label):
    t = (label or "").strip()
    if is_cancel_label(t):
        return False
    return "Feita" in t


def is_reivindicar_label(label):
    t = (label or "").strip()
    if is_cancel_label(t):
        return False
    return "Reivindicar" in t


def allowed_group_click(label):
    """Únicos cliques permitidos no grupo. Nunca Cancelar."""
    if is_cancel_label(label):
        return False
    return is_confirm_label(label) or is_feita_label(label) or is_reivindicar_label(label)
