#!/usr/bin/env python3
"""Regras do worker Fácil — 1 pedido por vez, nunca reivindica o já aberto."""
from worker_rules import claim_allowed, decide_next_action


def test_grupo_limpo_reivindica():
    assert decide_next_action([], None, set()) == ("claim", None)
    assert claim_allowed(0) is True


def test_pedido_atual_aberto_resume():
    opens = [{"pedido_id": "aaa", "payload": "111|Claro|30", "msg_id": 1}]
    assert decide_next_action(opens, "aaa", set()) == ("resume", "aaa")
    assert claim_allowed(1) is False


def test_ja_reivindicado_bloqueia_novo():
    opens = [{"pedido_id": "old", "payload": "67993286345|CLARO|35", "msg_id": 71553}]
    assert decide_next_action(opens, None, set()) == ("block", None)
    assert claim_allowed(len(opens)) is False


def test_dois_abertos_sem_current_bloqueia():
    opens = [
        {"pedido_id": "a", "payload": "91985241350|CLARO|30", "msg_id": 1},
        {"pedido_id": "b", "payload": "67993286345|CLARO|35", "msg_id": 2},
    ]
    assert decide_next_action(opens, None, set()) == ("block", None)


def test_dois_abertos_resume_so_o_do_bot():
    opens = [
        {"pedido_id": "a", "payload": "91985241350|CLARO|30", "msg_id": 1},
        {"pedido_id": "b", "payload": "67993286345|CLARO|35", "msg_id": 2},
    ]
    assert decide_next_action(opens, None, {"91985241350"}) == ("resume", "a")


def test_dois_abertos_current_vence_bot():
    opens = [
        {"pedido_id": "a", "payload": "91985241350|CLARO|30", "msg_id": 1},
        {"pedido_id": "b", "payload": "67993286345|CLARO|35", "msg_id": 2},
    ]
    assert decide_next_action(opens, "b", {"91985241350"}) == ("resume", "b")


def test_nao_resume_dois_no_bot():
    opens = [
        {"pedido_id": "a", "payload": "111|CLARO|30", "msg_id": 1},
        {"pedido_id": "b", "payload": "222|CLARO|35", "msg_id": 2},
    ]
    assert decide_next_action(opens, None, {"111", "222"}) == ("block", None)


def test_nunca_cancela_botoes_do_grupo():
    botoes = ["✅ Confirmar", "✅ Cancelar", "✅ Cancelar", "❌ Cancelar", "🚫 Blacklist"]
    from worker_rules import allowed_group_click, is_cancel_label, is_confirm_label

    assert is_confirm_label("✅ Confirmar")
    assert not is_confirm_label("✅ Cancelar")
    assert not is_confirm_label("❌ Cancelar")
    for b in botoes:
        if "Cancelar" in b:
            assert is_cancel_label(b)
            assert not allowed_group_click(b)
    assert allowed_group_click("✅ Confirmar")
    assert allowed_group_click("✅ Feita")
    assert allowed_group_click("📌 Reivindicar")
    assert not allowed_group_click("🚫 Blacklist")


def test_retry_mesmo_numero_erro_igual_para():
    from worker_rules import error_fingerprint, next_after_bot_result

    n = "67993286345"
    t1 = "**Erro** 🔑 `11991007672` → 📱 `67993286345` Falha no login (429): Too Many Requests"
    t2 = "**Erro** 🔑 `11991000516` → 📱 `67993286345` Falha no login (429): Too Many Requests"
    k1 = error_fingerprint("fail", t1, n)
    k2 = error_fingerprint("fail", t2, n)
    assert k1 == k2
    assert next_after_bot_result("fail", k1, None) == "retry"
    assert next_after_bot_result("fail", k2, k1) == "retry"


def test_erro_diferente_no_mesmo_numero_retenta():
    from worker_rules import error_fingerprint, next_after_bot_result

    n = "67993286345"
    a = error_fingerprint("fail", "Falha no login (429): Too Many Requests", n)
    b = error_fingerprint("fail_login", "Não iniciou Login 11991000516 falhou", n)
    assert a != b
    assert next_after_bot_result("fail_login", b, a) == "retry"


def test_erro_igual_em_numero_diferente_nao_para():
    from worker_rules import error_fingerprint, next_after_bot_result

    t = "Falha no login (429): Too Many Requests"
    k1 = error_fingerprint("fail", t, "11111111111")
    k2 = error_fingerprint("fail", t, "22222222222")
    assert k1 != k2
    assert next_after_bot_result("fail", k2, k1) == "retry"


def test_cartao_bloqueado_com_fila_e_progress():
    from facil_group import classify_bot_response
    from worker_rules import next_after_bot_result

    t = (
        "**Recarga negada** 💰 R$ 30,00 📱 `91985241350` "
        "78 - CARTAO BLOQUEADO Removido da fila · restam 208"
    )
    assert classify_bot_response(t) == "denied"
    t2 = "**✅ APROVADA** 📱 `92999512445` Confirmada em 141s"
    assert classify_bot_response(t2) == "approved"
    t3 = (
        "**Validação 3DS** 📱 `31998793327` Confirme no app ou SMS do banco "
        "Removido da fila · restam 203"
    )
    assert classify_bot_response(t3) == "3ds"
    t4 = "Processando Aguardando checkout…"
    assert classify_bot_response(t4) == "progress"
    t5 = (
        "**Preparando** |  | 🔑 `11991008848`  →  📱 `31998793327` |  | "
        "__Limpando cartões do login…__"
    )
    assert classify_bot_response(t5) == "progress"
    t6 = (
        "**Recarga automática** | 💰 **R$30,00** | 🔑 `11991003621` → 📱 `69992568665` | "
        "__Pegando cartão da fila…__"
    )
    assert classify_bot_response(t6) == "progress"
    t7 = (
        "**Conferindo saldo** | 💰 **R$30,00** | 🔑 `11991000872` → 📱 `69992568665` | "
        "__Lendo saldo e validade após a recarga…__"
    )
    assert classify_bot_response(t7) == "progress"
    welcome = (
        "<b>📱 Link Claro</b>\n\n"
        "Recarga automática com fila de cartões.\n\n"
        "Escolha o modo:"
    )
    assert classify_bot_response(welcome) == "other"
    from facil_group import is_actionable_response, is_terminal_kind

    assert not is_actionable_response(t6)
    assert not is_actionable_response(t7)
    assert is_terminal_kind("approved")
    assert not is_terminal_kind("progress")
    assert not is_terminal_kind("other")
    assert next_after_bot_result("3ds", "n|3ds|x", None) == "retry"
    assert next_after_bot_result("other", "n|other|x", None) == "retry"
    assert next_after_bot_result("timeout", "n|timeout|x", None) == "retry"
    assert next_after_bot_result("approved", "n|approved|x", None) == "close"


def test_login_429_nao_e_resultado_final():
    from facil_group import classify_bot_response, is_actionable_response, pick_bot_state

    login_429 = (
        "**Erro** 🔑 `11991009444` → 📱 `81993931753` "
        "Falha no login (429): Too Many Requests"
    )
    assert classify_bot_response(login_429) == "progress"
    assert not is_actionable_response(login_429)

    card_fail = (
        "**Falha na automação** 💰 R$ 30,00 🔑 `11991003526` → 📱 `81993931753` "
        "12 - ERRO NO CARTAO Voltou pra fila"
    )
    assert classify_bot_response(card_fail) == "fail"
    assert is_actionable_response(card_fail)

    nao_iniciou = "**Não iniciou** 💰 R$ 30,00 📱 `81993931753` Falha no login (429)"
    assert classify_bot_response(nao_iniciou) == "fail_login"

    # Erro antigo não manda reenviar se a mensagem mais nova ainda é progresso
    rows = [
        ("progress", login_429),
        ("fail", card_fail),
    ]
    assert pick_bot_state(rows) == ("progress", login_429)


def test_fila_vazia_e_erro_final():
    from facil_group import classify_bot_response, is_global_fail

    t = "❌ Fila automática vazia.\n\nEnvie cartões: NUMERO|MM|AAAA|CVV"
    assert is_global_fail(t)
    assert classify_bot_response(t) == "fail"


def test_progresso_velho_nao_trava_worker():
    from worker_rules import is_stale_progress, stale_progress_as

    assert is_stale_progress("progress", 20 * 60) is True
    assert is_stale_progress("progress", 60) is False
    assert is_stale_progress("approved", 20 * 60) is False
    conferindo = "**Conferindo saldo**\n__A API atrasou — nova leitura 3/4__"
    assert is_stale_progress("progress", 4 * 60, text=conferindo) is True
    assert is_stale_progress("progress", 2 * 60, text=conferindo) is False
    checkout = "**Processando**\n__Aguardando checkout… (24s)__"
    assert is_stale_progress("progress", 6 * 60, text=checkout) is True
    assert is_stale_progress("progress", 4 * 60, text=checkout) is False
    assert stale_progress_as(conferindo) == "approved"
    assert stale_progress_as("**Preparando**\n__Gerando login…__") == "idle"


def test_halt_espera_seguir_ou_pedido_fechado():
    from worker_rules import halt_next_step

    assert halt_next_step(False, True) == "wait"
    assert halt_next_step(True, True) == "retry_same"
    assert halt_next_step(False, False) == "next"
    assert halt_next_step(True, False) == "retry_same"


if __name__ == "__main__":
    tests = [v for k, v in list(globals().items()) if k.startswith("test_")]
    for fn in tests:
        fn()
        print("ok", fn.__name__)
    print(f"{len(tests)} testes OK")
