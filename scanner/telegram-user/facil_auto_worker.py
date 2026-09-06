#!/usr/bin/env python3
"""
Worker contínuo: grupo Fácil RECARGAS → bot Linkclaro → Feita+Confirmar.

- Retoma pedidos PROCESSANDO do atendente antes de reivindicar novos
- Só aceita resposta do bot que mencione o número do payload
- Mesmo erro 2x → próximo pedido Claro
"""
import argparse
import asyncio
import json
import re
import sys
from datetime import datetime, timezone

from telethon import TelegramClient

from config import DATA_DIR, SESSION_PATH, api_id, api_hash, load_env_file
from facil_group import (
    BOT_USERNAME,
    GROUP_ID,
    classify_bot_response,
    is_actionable_response,
    parse_payload,
    parse_pedido_id,
    payload_target,
    response_matches_target,
)

STATE_FILE = DATA_DIR / "facil-auto-worker.json"
LOCK_FILE = DATA_DIR / "facil-auto-worker.lock"
MIN_SEND_GAP_SEC = 45
ATTENDEE = "Lucasfer97"
IDLE_POLL_SEC = 60
RESUME_MAX_AGE_SEC = 900  # só retoma PROCESSANDO recente com bot ativo


def log(msg):
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def save_state(data):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def acquire_lock():
    if LOCK_FILE.exists():
        try:
            age = datetime.now(timezone.utc).timestamp() - LOCK_FILE.stat().st_mtime
            if age < 7200:
                return False
        except OSError:
            pass
    LOCK_FILE.write_text(str(datetime.now(timezone.utc).isoformat()), encoding="utf-8")
    return True


def release_lock():
    LOCK_FILE.unlink(missing_ok=True)


async def find_claimable_claro(g, tg, exclude_pedidos=None, limit=300):
    exclude = set(exclude_pedidos or [])
    candidates = []
    async for m in tg.iter_messages(g, limit=limit):
        text = m.text or ""
        if "Novo Pedido de Recarga" not in text:
            continue
        if not re.search(r"\*\*Operadora:\*\*\s*Claro", text, re.I):
            continue
        labels = [getattr(b, "text", "") for row in (m.buttons or []) for b in row]
        if not any("Reivindicar" in lb for lb in labels):
            continue
        pid = parse_pedido_id(text)
        if pid and pid in exclude:
            continue
        candidates.append((m.date, m, pid))
    return candidates


async def find_my_processing(g, tg, attendee=ATTENDEE, max_age_sec=RESUME_MAX_AGE_SEC):
    """Só retoma PROCESSANDO recente com botões de ação (pedido em curso)."""
    now = datetime.now(timezone.utc)
    async for m in tg.iter_messages(g, limit=80):
        text = m.text or ""
        if "PROCESSANDO" not in text or attendee not in text:
            continue
        if not m.buttons:
            continue
        labels = [getattr(b, "text", "") for row in m.buttons for b in row]
        if not any(x in lb for lb in labels for x in ("Feita", "Cancelar", "Blacklist")):
            continue
        if m.date:
            age = (now - m.date.replace(tzinfo=timezone.utc)).total_seconds()
            if age > max_age_sec:
                continue
        payload = parse_payload(text)
        pedido = parse_pedido_id(text)
        if payload and pedido:
            return payload, pedido, m.id
    return None, None, None


async def claim_oldest_claro(g, tg, exclude_pedidos=None):
    candidates = await find_claimable_claro(g, tg, exclude_pedidos)
    if not candidates:
        return None, None, None

    # Mais antigo primeiro (iter_messages = recente→antigo; candidates[-1] = mais antigo)
    for _, message, pedido_id in reversed(candidates):
        labels = [getattr(b, "text", "") for row in (message.buttons or []) for b in row]
        claim_label = next((lb for lb in labels if "Reivindicar" in lb), None)
        if not claim_label:
            continue

        await message.click(text=claim_label)
        await asyncio.sleep(3)
        updated = await tg.get_messages(g, ids=message.id)
        text = updated.text or ""
        payload = parse_payload(text)

        if "PROCESSANDO" in text and payload and ATTENDEE in text:
            return payload, pedido_id, message.id

        log(f"Reivindicar falhou em {pedido_id} — msg ainda sem PROCESSANDO")

    return None, None, None


async def find_processing_msg(g, tg, pedido_id):
    async for m in tg.iter_messages(g, limit=100):
        text = m.text or ""
        if pedido_id in text and "PROCESSANDO" in text:
            return m
    return None


async def mark_feita(g, tg, pedido_id):
    msg = await find_processing_msg(g, tg, pedido_id)
    if not msg or not msg.buttons:
        log(f"Feita: msg pedido {pedido_id} não encontrada")
        return False
    clicked_feita = False
    for row in msg.buttons:
        for b in row:
            if "Feita" in getattr(b, "text", ""):
                await msg.click(text=b.text)
                log(f"Clicou Feita no pedido {pedido_id}")
                await asyncio.sleep(2)
                clicked_feita = True
                break
        if clicked_feita:
            break
    if not clicked_feita:
        return False

    for _ in range(15):
        async for m in tg.iter_messages(g, limit=40):
            t = m.text or ""
            if pedido_id not in t or "Tem certeza" not in t or not m.buttons:
                continue
            for row in m.buttons:
                for b in row:
                    if "Confirmar" in getattr(b, "text", ""):
                        await m.click(text=b.text)
                        log(f"Clicou Confirmar no pedido {pedido_id} (msg {m.id})")
                        await asyncio.sleep(2)
                        return True
        await asyncio.sleep(1)

    log(f"Confirmar não encontrado para pedido {pedido_id}")
    return False


async def wait_bot_reply(tg, bot, after_id, target, timeout=600):
    deadline = asyncio.get_event_loop().time() + timeout
    seen_texts = set()
    anchor_id = None

    while asyncio.get_event_loop().time() < deadline:
        ids_to_check = []
        if anchor_id:
            ids_to_check.append(anchor_id)
        async for m in tg.iter_messages(bot, limit=10):
            if m.out:
                continue
            if m.id <= after_id and anchor_id is None:
                continue
            if anchor_id is None:
                anchor_id = m.id
            if m.id not in ids_to_check:
                ids_to_check.append(m.id)

        for mid in ids_to_check:
            updated = await tg.get_messages(bot, ids=mid)
            if not updated:
                continue
            text = updated.text or ""
            if not text.strip() or text in seen_texts:
                continue
            if not response_matches_target(text, target):
                continue
            kind = classify_bot_response(text)
            if kind == "progress":
                seen_texts.add(text)
                log(f"BOT [{kind}] {target}: {text[:220].replace(chr(10), ' | ')}")
                continue
            if is_actionable_response(text):
                seen_texts.add(text)
                log(f"BOT [{kind}] {target}: {text[:280].replace(chr(10), ' | ')}")
                return kind, text

        await asyncio.sleep(2)

    return "timeout", ""


async def bot_state_for_target(tg, bot, target, limit=20):
    """Estado atual do bot para um número (evita reenvio duplicado)."""
    async for m in tg.iter_messages(bot, limit=limit):
        if m.out:
            continue
        text = m.text or ""
        if not response_matches_target(text, target):
            continue
        kind = classify_bot_response(text)
        if kind == "approved":
            return "approved", text
        if kind == "progress":
            return "progress", text[:120]
        if is_actionable_response(text):
            return kind, text[:120]
    return "idle", ""


async def acquire_order(g, tg, bot, tried_pedidos, resume_processing=False):
    # 1) Sempre tenta reivindicar pedido NOVO (botão Reivindicar)
    payload, pedido, _ = await claim_oldest_claro(g, tg, exclude_pedidos=tried_pedidos)
    if payload:
        log(f"Reivindicado {pedido} → {payload}")
        return payload, pedido

    if not resume_processing:
        return None, None

    # 2) Opcional: retoma só PROCESSANDO recente com bot ainda ativo nesse número
    payload, pedido, _ = await find_my_processing(g, tg)
    if not payload:
        return None, None

    target = payload_target(payload)
    state, _ = await bot_state_for_target(tg, bot, target)
    if state not in ("progress", "approved"):
        log(f"Ignora PROCESSANDO antigo {pedido} ({target}) — bot idle")
        return None, None

    log(f"Retomando PROCESSANDO ativo {pedido} → {payload}")
    return payload, pedido


async def process_one_order(g, tg, bot, payload, pedido_id, max_cycles=50):
    target = payload_target(payload)
    last_send_at = 0.0
    last_error = None
    same_streak = 0

    state, hint = await bot_state_for_target(tg, bot, target)
    if state == "approved":
        log(f"Bot já APROVOU {target} — fechando no grupo")
        await mark_feita(g, tg, pedido_id)
        save_state({"result": "approved", "payload": payload, "pedido_id": pedido_id, "at": datetime.now(timezone.utc).isoformat()})
        return "approved"

    if state == "progress":
        log(f"Bot já processando {target} — aguardando ({hint})")
        kind, text = await wait_bot_reply(tg, bot, 0, target, timeout=600)
        if kind == "approved":
            await mark_feita(g, tg, pedido_id)
            save_state({"result": "approved", "payload": payload, "pedido_id": pedido_id, "at": datetime.now(timezone.utc).isoformat()})
            return "approved"
        if kind == "timeout":
            log(f"Timeout aguardando {target}")
            return "timeout"

    for cycle in range(1, max_cycles + 1):
        log(f"=== Ciclo {cycle} | pedido={pedido_id} | {payload} ===")

        state, hint = await bot_state_for_target(tg, bot, target)
        if state == "approved":
            log(f"APROVADA (detectada antes do envio)")
            await mark_feita(g, tg, pedido_id)
            save_state({"result": "approved", "payload": payload, "pedido_id": pedido_id, "at": datetime.now(timezone.utc).isoformat()})
            return "approved"
        if state == "progress":
            log(f"Bot ocupado com {target} — aguardando 20s")
            await asyncio.sleep(20)
            continue

        gap = asyncio.get_event_loop().time() - last_send_at
        if last_send_at and gap < MIN_SEND_GAP_SEC:
            wait = MIN_SEND_GAP_SEC - gap
            log(f"Cooldown {wait:.0f}s")
            await asyncio.sleep(wait)

        sent = await tg.send_message(bot, payload)
        last_send_at = asyncio.get_event_loop().time()
        log(f"Enviado: {payload}")

        kind, text = await wait_bot_reply(tg, bot, sent.id, target, timeout=600)

        if kind == "approved":
            log("APROVADA!")
            save_state({"result": "approved", "payload": payload, "pedido_id": pedido_id, "at": datetime.now(timezone.utc).isoformat()})
            await mark_feita(g, tg, pedido_id)
            return "approved"

        if kind == "timeout":
            log("Timeout — aguardando bot (sem reenvio)")
            await asyncio.sleep(30)
            continue

        err_key = kind
        if kind == "denied":
            m = re.search(r"CARTAO|GATE|ERRO[^\n]*", text, re.I)
            if m:
                err_key = f"denied:{m.group(0)[:30]}"

        if err_key == last_error:
            same_streak += 1
        else:
            same_streak = 1
            last_error = err_key

        log(f"Erro={err_key} streak={same_streak}")

        if same_streak >= 2:
            log("Mesmo erro 2x — abandona pedido")
            save_state({"result": err_key, "payload": payload, "pedido_id": pedido_id, "at": datetime.now(timezone.utc).isoformat()})
            return "failed"

        log("Aguarda 15s antes de retry")
        await asyncio.sleep(15)

    return "failed"


async def run_worker(payload=None, pedido_id=None, max_cycles=50, loop=False, idle_poll=IDLE_POLL_SEC, resume_processing=False):
    load_env_file()
    if not acquire_lock():
        log("Outro worker já ativo — abortando")
        return 1

    tg = TelegramClient(str(SESSION_PATH), api_id(), api_hash())
    await tg.connect()
    g = await tg.get_entity(GROUP_ID)
    bot = await tg.get_entity(BOT_USERNAME)

    tried_pedidos = []
    exit_code = 0

    try:
        while True:
            current_payload = payload
            current_pedido = pedido_id

            if not current_payload:
                current_payload, current_pedido = await acquire_order(
                    g, tg, bot, tried_pedidos, resume_processing=resume_processing
                )
                if not current_payload:
                    if not loop:
                        log("Sem pedido Claro disponível")
                        exit_code = 1
                        break
                    log(f"Sem pedidos — aguardando {idle_poll}s")
                    await asyncio.sleep(idle_poll)
                    continue

            if current_pedido and current_pedido not in tried_pedidos:
                tried_pedidos.append(current_pedido)

            result = await process_one_order(g, tg, bot, current_payload, current_pedido, max_cycles)
            log(f"Resultado pedido {current_pedido}: {result}")

            payload = None
            pedido_id = None

            if not loop:
                exit_code = 0 if result == "approved" else 1
                break

            if result in ("failed", "timeout"):
                await asyncio.sleep(10)
            else:
                await asyncio.sleep(5)

    finally:
        release_lock()
        await tg.disconnect()

    return exit_code


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", help="Ex: 77988745817|CLARO|30")
    parser.add_argument("--pedido", help="ID pedido grupo")
    parser.add_argument("--max-cycles", type=int, default=50)
    parser.add_argument("--loop", action="store_true", help="Processa pedidos continuamente")
    parser.add_argument("--idle-poll", type=int, default=IDLE_POLL_SEC)
    parser.add_argument(
        "--resume-processing",
        action="store_true",
        help="Se não houver Reivindicar, retoma PROCESSANDO recente com bot ativo",
    )
    args = parser.parse_args()
    raise SystemExit(
        asyncio.run(
            run_worker(
                args.payload,
                args.pedido,
                args.max_cycles,
                args.loop,
                args.idle_poll,
                args.resume_processing,
            )
        )
    )


if __name__ == "__main__":
    main()
