#!/usr/bin/env python3
"""
Worker: payload grupo → bot Linkclaro.
Na resposta: reenvia payload. Mesmo erro 2x → reivindica próximo Claro.
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
)

STATE_FILE = DATA_DIR / "facil-auto-worker.json"
LOCK_FILE = DATA_DIR / "facil-auto-worker.lock"
MIN_SEND_GAP_SEC = 45


def log(msg):
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)


def save_state(data):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


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


async def claim_oldest_claro(g, tg, exclude_pedidos=None):
    candidates = await find_claimable_claro(g, tg, exclude_pedidos)
    if not candidates:
        return None, None, None

    _, message, pedido_id = candidates[-1]
    labels = [getattr(b, "text", "") for row in (message.buttons or []) for b in row]
    for label in labels:
        if "Reivindicar" in label:
            await message.click(text=label)
            break
    else:
        await message.click(0)

    await asyncio.sleep(3)
    updated = await tg.get_messages(g, ids=message.id)
    payload = parse_payload(updated.text or "")
    return payload, pedido_id, message.id


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
    for row in msg.buttons:
        for b in row:
            if "Feita" in getattr(b, "text", ""):
                await msg.click(text=b.text)
                log(f"Clicou Feita no pedido {pedido_id}")
                await asyncio.sleep(2)
                break
    else:
        return False

    for _ in range(12):
        async for m in tg.iter_messages(g, limit=30):
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


async def wait_bot_reply(tg, bot, after_id, timeout=600):
    deadline = asyncio.get_event_loop().time() + timeout
    seen_texts = set()
    anchor_id = None

    # Aguarda primeira resposta do bot (nova msg ou edição)
    while asyncio.get_event_loop().time() < deadline:
        newest = None
        async for m in tg.iter_messages(bot, limit=8):
            if m.out:
                continue
            if m.id <= after_id and anchor_id is None:
                continue
            newest = m
            break

        if newest and anchor_id is None:
            anchor_id = newest.id

        ids_to_check = []
        if anchor_id:
            ids_to_check.append(anchor_id)
        async for m in tg.iter_messages(bot, min_id=after_id, limit=5):
            if not m.out and m.id not in ids_to_check:
                ids_to_check.append(m.id)

        for mid in ids_to_check:
            updated = await tg.get_messages(bot, ids=mid)
            if not updated:
                continue
            text = updated.text or ""
            if not text.strip() or text in seen_texts:
                continue
            kind = classify_bot_response(text)
            if kind == "progress":
                seen_texts.add(text)
                log(f"BOT [{kind}]: {text[:280].replace(chr(10), ' | ')}")
                continue
            if is_actionable_response(text):
                seen_texts.add(text)
                log(f"BOT [{kind}]: {text[:280].replace(chr(10), ' | ')}")
                return kind, text

        await asyncio.sleep(1.5)

    return "timeout", ""


async def bot_busy_with_target(tg, bot, target_digits, limit=12):
    """Evita reenviar se o bot já está processando esse número."""
    async for m in tg.iter_messages(bot, limit=limit):
        if m.out:
            continue
        text = m.text or ""
        if target_digits not in text.replace("`", ""):
            continue
        kind = classify_bot_response(text)
        if kind == "progress":
            return True, text[:120]
    return False, ""


async def run_worker(payload=None, pedido_id=None, max_cycles=50):
    load_env_file()
    if LOCK_FILE.exists():
        log("Outro worker já ativo — abortando")
        return 1
    LOCK_FILE.write_text(str(datetime.now(timezone.utc).isoformat()), encoding="utf-8")

    last_send_at = 0.0
    tg = TelegramClient(str(SESSION_PATH), api_id(), api_hash())
    await tg.connect()
    g = await tg.get_entity(GROUP_ID)
    bot = await tg.get_entity(BOT_USERNAME)

    tried_pedidos = []
    if pedido_id:
        tried_pedidos.append(pedido_id)

    if not payload:
        payload, pedido_id, _ = await claim_oldest_claro(g, tg)
        if not payload:
            log("Sem pedido Claro para reivindicar")
            LOCK_FILE.unlink(missing_ok=True)
            await tg.disconnect()
            return 1
        tried_pedidos.append(pedido_id)
        log(f"Reivindicado {pedido_id} → {payload}")

    last_error = None
    same_streak = 0

    for cycle in range(1, max_cycles + 1):
        log(f"=== Ciclo {cycle} | pedido={pedido_id} | payload={payload} ===")

        target = payload.split("|")[0] if payload else ""
        busy, hint = await bot_busy_with_target(tg, bot, target)
        if busy:
            log(f"Bot ainda processando {target} — aguardando 20s ({hint})")
            await asyncio.sleep(20)
            continue

        gap = asyncio.get_event_loop().time() - last_send_at
        if last_send_at and gap < MIN_SEND_GAP_SEC:
            wait = MIN_SEND_GAP_SEC - gap
            log(f"Cooldown {wait:.0f}s antes do próximo envio")
            await asyncio.sleep(wait)

        sent = await tg.send_message(bot, payload)
        last_send_at = asyncio.get_event_loop().time()
        log(f"Enviado 1x: {payload}")

        kind, text = await wait_bot_reply(tg, bot, sent.id, timeout=600)

        if kind == "approved":
            log("APROVADA!")
            save_state({"result": "approved", "payload": payload, "pedido_id": pedido_id, "at": datetime.now(timezone.utc).isoformat()})
            await mark_feita(g, tg, pedido_id)
            LOCK_FILE.unlink(missing_ok=True)
            await tg.disconnect()
            return 0

        if kind == "timeout":
            log("Timeout — NÃO reenvia; aguarda bot terminar")
            await asyncio.sleep(30)
            continue

        err_key = kind
        if kind == "denied":
            m = re.search(r"CARTAO|GATE|ERRO[^\\n]*", text, re.I)
            if m:
                err_key = f"denied:{m.group(0)[:30]}"

        if err_key == last_error:
            same_streak += 1
        else:
            same_streak = 1
            last_error = err_key

        log(f"Erro={err_key} streak={same_streak}")

        if same_streak >= 2:
            log("Mesmo erro 2x — próximo Claro")
            tried_pedidos.append(pedido_id)
            new_payload, new_pedido, _ = await claim_oldest_claro(g, tg, exclude_pedidos=tried_pedidos)
            if not new_payload:
                log("Sem mais pedidos Claro disponíveis")
                LOCK_FILE.unlink(missing_ok=True)
                await tg.disconnect()
                return 2
            payload = new_payload
            pedido_id = new_pedido
            tried_pedidos.append(pedido_id)
            same_streak = 0
            last_error = None
            log(f"Novo pedido {pedido_id} → {payload}")
            continue

        log("Resposta final — aguarda 10s e reenvia 1x se necessário")
        await asyncio.sleep(10)

    LOCK_FILE.unlink(missing_ok=True)
    await tg.disconnect()
    return 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", help="Ex: 77988745817|CLARO|30")
    parser.add_argument("--pedido", help="ID pedido grupo")
    parser.add_argument("--max-cycles", type=int, default=50)
    args = parser.parse_args()
    raise SystemExit(asyncio.run(run_worker(args.payload, args.pedido, args.max_cycles)))


if __name__ == "__main__":
    main()
