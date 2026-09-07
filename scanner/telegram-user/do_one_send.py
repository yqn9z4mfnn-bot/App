#!/usr/bin/env python3
"""Um único envio + monitor. Aborta se lock existir."""
import asyncio
import sys
from pathlib import Path

from telethon import TelegramClient

from config import DATA_DIR, SESSION_PATH, api_id, api_hash, load_env_file
from facil_group import BOT_USERNAME, GROUP_ID, classify_bot_response, is_actionable_response, payload_target, response_matches_target
from group_close import close_order_in_group

LOCK = DATA_DIR / "send.lock"


async def wait_bot(tg, bot, after_id, target, timeout=600):
    deadline = asyncio.get_event_loop().time() + timeout
    seen, anchor = set(), None
    while asyncio.get_event_loop().time() < deadline:
        ids = []
        async for m in tg.iter_messages(bot, limit=10):
            if m.out:
                continue
            if m.id <= after_id and not anchor:
                continue
            if anchor is None:
                anchor = m.id
            if m.id not in ids:
                ids.append(m.id)
        if anchor and anchor not in ids:
            ids.insert(0, anchor)
        for mid in ids:
            u = await tg.get_messages(bot, ids=mid)
            text = u.text or ""
            if not text or text in seen:
                continue
            if not response_matches_target(text, target):
                continue
            kind = classify_bot_response(text)
            if kind == "progress":
                seen.add(text)
                print(f"[progress] {text[:180].replace(chr(10), ' | ')}", flush=True)
                continue
            if is_actionable_response(text):
                print(f"[{kind}] {text[:500]}", flush=True)
                return kind, text
        await asyncio.sleep(2)
    return "timeout", ""


async def close_pedido(tg, g, pedido):
    return await close_order_in_group(g, tg, pedido, log=lambda m: print(m, flush=True))


async def main():
    if len(sys.argv) < 3:
        print("Uso: do_one_send.py PAYLOAD PEDIDO_ID")
        return 1

    payload, pedido = sys.argv[1], sys.argv[2]
    load_env_file()
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if LOCK.exists():
        print("LOCK ativo — abortando para não duplicar envio")
        return 1

    LOCK.write_text(payload, encoding="utf-8")
    try:
        tg = TelegramClient(str(SESSION_PATH), api_id(), api_hash())
        await tg.connect()
        bot = await tg.get_entity(BOT_USERNAME)
        g = await tg.get_entity(GROUP_ID)

        print(f"ENVIO UNICO: {payload}", flush=True)
        sent = await tg.send_message(bot, payload)
        kind, _ = await wait_bot(tg, bot, sent.id, payload_target(payload), 600)
        print(f"RESULTADO: {kind}", flush=True)

        if kind == "approved":
            await close_pedido(tg, g, pedido)
            print("GRUPO FECHADO", flush=True)

        await tg.disconnect()
        return 0 if kind == "approved" else 1
    finally:
        LOCK.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
