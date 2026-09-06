#!/usr/bin/env python3
"""
Worker contínuo: grupo Fácil RECARGAS → bot Linkclaro → Feita+Confirmar.

Regras:
- 1 pedido por vez: só reivindica novo após Feita+Confirmar no grupo
- 1 clique Reivindicar por tentativa (nunca reivindica 2 seguidos)
- 1 envio ao bot por pedido (filtro MSISDN)
"""
import argparse
import asyncio
import json
import re
from datetime import datetime, timezone

from telethon import TelegramClient

from config import DATA_DIR, SESSION_PATH, api_id, api_hash, load_env_file
from facil_group import (
    BOT_USERNAME,
    GROUP_ID,
    classify_bot_response,
    is_actionable_response,
    is_feita_final,
    parse_payload,
    parse_pedido_id,
    payload_target,
    response_matches_target,
)
from group_close import close_order_in_group, find_processing_msg

STATE_FILE = DATA_DIR / "facil-auto-worker.json"
CURRENT_FILE = DATA_DIR / "worker-current.json"
LOCK_FILE = DATA_DIR / "facil-auto-worker.lock"
MIN_SEND_GAP_SEC = 45
IDLE_POLL_SEC = 60
ATTENDEE = "Lucasfer97"


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


def load_current_pedido():
    if not CURRENT_FILE.exists():
        return None
    try:
        return json.loads(CURRENT_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def save_current_pedido(pedido_id, payload, msg_id=None):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CURRENT_FILE.write_text(
        json.dumps(
            {
                "pedido_id": pedido_id,
                "payload": payload,
                "msg_id": msg_id,
                "claimed_at": datetime.now(timezone.utc).isoformat(),
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )


def clear_current_pedido():
    CURRENT_FILE.unlink(missing_ok=True)


async def pedido_still_open(g, tg, pedido_id):
    async for m in tg.iter_messages(g, limit=100):
        text = m.text or ""
        if pedido_id not in text:
            continue
        if is_feita_final(text):
            return False
        if "PROCESSANDO" in text or "Tem certeza" in text:
            return True
    return False


async def list_stray_processing(g, tg, own_pedido_id=None, attendee=ATTENDEE):
    """PROCESSANDO no nosso nome que NÃO é o pedido ativo do worker."""
    stray = []
    async for m in tg.iter_messages(g, limit=80):
        text = m.text or ""
        if attendee not in text or "PROCESSANDO" not in text:
            continue
        pedido = parse_pedido_id(text)
        if not pedido or pedido == own_pedido_id or is_feita_final(text):
            continue
        payload = parse_payload(text)
        if payload:
            stray.append((pedido, payload, m.id))
    return stray


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


async def find_my_open_processing(g, tg, attendee=ATTENDEE):
    """Deprecated: use load_current_pedido + pedido_still_open."""
    current = load_current_pedido()
    if not current:
        return None, None, None
    pedido = current.get("pedido_id")
    payload = current.get("payload")
    if pedido and payload and await pedido_still_open(g, tg, pedido):
        return payload, pedido, current.get("msg_id")
    if pedido and not await pedido_still_open(g, tg, pedido):
        clear_current_pedido()
    return None, None, None


async def claim_one_claro(g, tg):
    """Reivindica UM pedido (o mais antigo). Nunca tenta o próximo se falhar."""
    candidates = await find_claimable_claro(g, tg)
    if not candidates:
        return None, None, None

    _, message, pedido_id = candidates[-1]
    labels = [getattr(b, "text", "") for row in (message.buttons or []) for b in row]
    claim_label = next((lb for lb in labels if "Reivindicar" in lb), None)
    if not claim_label:
        return None, None, None

    await message.click(text=claim_label)
    log(f"Clicou Reivindicar em {pedido_id} (msg {message.id})")

    for wait in range(8):
        await asyncio.sleep(1)
        updated = await tg.get_messages(g, ids=message.id)
        text = updated.text or ""
        payload = parse_payload(text)
        if "PROCESSANDO" in text and payload and ATTENDEE in text:
            save_current_pedido(pedido_id, payload, message.id)
            return payload, pedido_id, message.id
        if "Reivindicar" not in str([getattr(b, "text", "") for row in (updated.buttons or []) for b in row]):
            if "PROCESSANDO" in text and ATTENDEE not in text:
                log(f"Pedido {pedido_id} reivindicado por outro — abortando")
                return None, None, None

    log(f"Reivindicar timeout em {pedido_id}")
    return None, None, None


async def bot_has_active_job(tg, bot, exclude_target=None, limit=15):
    """True se bot está em progress em qualquer número (não conta APROVADA antiga)."""
    async for m in tg.iter_messages(bot, limit=limit):
        if m.out:
            continue
        text = m.text or ""
        if exclude_target and response_matches_target(text, exclude_target):
            continue
        if classify_bot_response(text) == "progress":
            return True, text[:100]
    return False, ""


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


async def acquire_order(g, tg, bot):
    current = load_current_pedido()
    if current:
        pedido = current["pedido_id"]
        payload = current["payload"]
        if await pedido_still_open(g, tg, pedido):
            log(f"Retomando pedido do worker {pedido} → {payload}")
            return payload, pedido
        clear_current_pedido()
        log(f"Pedido ativo {pedido} já fechado — limpando registro")

    stray = await list_stray_processing(g, tg)
    for pedido, payload, msg_id in stray:
        log(f"Ignorando já reivindicado (não foi este worker): {pedido} → {payload} (msg {msg_id})")

    busy, hint = await bot_has_active_job(tg, bot)
    if busy:
        log(f"Bot ocupado — aguardando antes de reivindicar ({hint})")
        return None, None

    payload, pedido, msg_id = await claim_one_claro(g, tg)
    if payload:
        log(f"Reivindicado {pedido} → {payload}")
    return payload, pedido


async def process_one_order(g, tg, bot, payload, pedido_id, max_cycles=50):
    target = payload_target(payload)
    sent_once = False
    last_error = None
    same_streak = 0

    for cycle in range(1, max_cycles + 1):
        state, hint = await bot_state_for_target(tg, bot, target)

        if state == "approved":
            log(f"APROVADA {target}")
            closed = await close_order_in_group(g, tg, pedido_id, log=log)
            clear_current_pedido()
            save_state({
                "result": "closed" if closed else "approved_unconfirmed",
                "payload": payload,
                "pedido_id": pedido_id,
                "at": datetime.now(timezone.utc).isoformat(),
            })
            return "closed" if closed else "needs_confirm"

        if state == "progress":
            log(f"Bot processando {target} — aguardando")
            kind, _ = await wait_bot_reply(tg, bot, 0, target, timeout=600)
            if kind == "approved":
                closed = await close_order_in_group(g, tg, pedido_id, log=log)
                clear_current_pedido()
                save_state({
                    "result": "closed" if closed else "approved_unconfirmed",
                    "payload": payload,
                    "pedido_id": pedido_id,
                    "at": datetime.now(timezone.utc).isoformat(),
                })
                return "closed" if closed else "needs_confirm"
            if kind == "timeout":
                return "timeout"
            continue

        if sent_once:
            term, _hint = await bot_state_for_target(tg, bot, target)
            if term == "approved":
                log(f"APROVADA {target}")
                closed = await close_order_in_group(g, tg, pedido_id, log=log)
                clear_current_pedido()
                save_state({
                    "result": "closed" if closed else "approved_unconfirmed",
                    "payload": payload,
                    "pedido_id": pedido_id,
                    "at": datetime.now(timezone.utc).isoformat(),
                })
                return "closed" if closed else "needs_confirm"
            if term in ("fail", "fail_login", "denied", "3ds"):
                log(f"Bot respondeu {term} — encerra pedido {pedido_id}")
                clear_current_pedido()
                save_state({"result": term, "payload": payload, "pedido_id": pedido_id, "at": datetime.now(timezone.utc).isoformat()})
                return "failed"
            log("Já enviado 1x neste pedido — aguardando bot")
            await asyncio.sleep(20)
            continue

        busy, hint = await bot_has_active_job(tg, bot, exclude_target=target)
        if busy:
            log(f"Outro job no bot — aguardando 15s ({hint})")
            await asyncio.sleep(15)
            continue

        log(f"=== Ciclo {cycle} | pedido={pedido_id} | {payload} ===")
        sent = await tg.send_message(bot, payload)
        sent_once = True
        log(f"Enviado (único): {payload}")

        kind, text = await wait_bot_reply(tg, bot, sent.id, target, timeout=600)

        if kind == "approved":
            log("APROVADA!")
            closed = await close_order_in_group(g, tg, pedido_id, log=log)
            clear_current_pedido()
            save_state({
                "result": "closed" if closed else "approved_unconfirmed",
                "payload": payload,
                "pedido_id": pedido_id,
                "at": datetime.now(timezone.utc).isoformat(),
            })
            return "closed" if closed else "needs_confirm"

        if kind == "timeout":
            log("Timeout aguardando bot")
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
            clear_current_pedido()
            save_state({"result": err_key, "payload": payload, "pedido_id": pedido_id, "at": datetime.now(timezone.utc).isoformat()})
            return "failed"

        await asyncio.sleep(15)

    return "failed"


async def run_worker(payload=None, pedido_id=None, max_cycles=50, loop=False, idle_poll=IDLE_POLL_SEC):
    load_env_file()
    if not acquire_lock():
        log("Outro worker já ativo — abortando")
        return 1

    tg = TelegramClient(str(SESSION_PATH), api_id(), api_hash())
    await tg.connect()
    g = await tg.get_entity(GROUP_ID)
    bot = await tg.get_entity(BOT_USERNAME)

    pending_confirm = None
    exit_code = 0

    try:
        while True:
            if pending_confirm:
                pedido_id_retry, payload_retry = pending_confirm
                log(f"Retentando Confirmar {pedido_id_retry}")
                closed = await close_order_in_group(g, tg, pedido_id_retry, log=log)
                if closed:
                    pending_confirm = None
                    log(f"Grupo OK {pedido_id_retry}")
                else:
                    log(f"Confirmar pendente {pedido_id_retry} — não pega novo pedido")
                    await asyncio.sleep(10)
                    if loop:
                        continue
                    exit_code = 1
                    break

            current_payload = payload
            current_pedido = pedido_id

            if not current_payload:
                current_payload, current_pedido = await acquire_order(g, tg, bot)
                if not current_payload:
                    if not loop:
                        log("Sem pedido disponível")
                        exit_code = 1
                        break
                    log(f"Sem pedidos — aguardando {idle_poll}s")
                    await asyncio.sleep(idle_poll)
                    continue

            result = await process_one_order(g, tg, bot, current_payload, current_pedido, max_cycles)
            log(f"Resultado {current_pedido}: {result}")

            payload = None
            pedido_id = None

            if result == "needs_confirm":
                pending_confirm = (current_pedido, current_payload)
                continue

            if not loop:
                exit_code = 0 if result == "closed" else 1
                break

            if result == "closed":
                await asyncio.sleep(3)
            elif result in ("failed", "timeout"):
                await asyncio.sleep(10)
            else:
                await asyncio.sleep(5)

    finally:
        release_lock()
        await tg.disconnect()

    return exit_code


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload")
    parser.add_argument("--pedido")
    parser.add_argument("--max-cycles", type=int, default=50)
    parser.add_argument("--loop", action="store_true")
    parser.add_argument("--idle-poll", type=int, default=IDLE_POLL_SEC)
    args = parser.parse_args()
    raise SystemExit(asyncio.run(run_worker(args.payload, args.pedido, args.max_cycles, args.loop, args.idle_poll)))


if __name__ == "__main__":
    main()
