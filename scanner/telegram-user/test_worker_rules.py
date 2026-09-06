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


if __name__ == "__main__":
    tests = [v for k, v in list(globals().items()) if k.startswith("test_")]
    for fn in tests:
        fn()
        print("ok", fn.__name__)
    print(f"{len(tests)} testes OK")
