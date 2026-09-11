#!/usr/bin/env python3
"""Envia payload ao bot de recarga e aguarda resultado."""
import argparse
import asyncio
import re
import sys
from datetime import datetime, timezone

from telethon import TelegramClient

from config import SESSION_PATH, api_id, api_hash, load_env_file

BOT_USERNAME = "Linkclarotesbot"
APPROVED_RE = re.compile(r"APROVAD|SUCCESS|Recarga aprovada|Confirmada", re.I)
FAILED_RE = re.compile(r"NEGAD|RECUSAD|FALH|CANCELAD|ERRO|❌", re.I)


def is_approved(text):
    t = text or ""
    if APPROVED_RE.search(t) and not re.search(r"NAO.*APROVAD|NÃO.*APROVAD", t, re.I):
        return True
    return False


def is_terminal_fail(text):
    t = text or ""
    if is_approved(t):
        return False
    return bool(
        FAILED_RE.search(t)
        and re.search(r"RECARGA|cartão|cartao|checkout|3DS|VBV", t, re.I)
    )


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("payload", help="Ex: 77988745817|CLARO|30")
    parser.add_argument("--timeout", type=int, default=600, help="Segundos (default 600)")
    parser.add_argument("--bot", default=BOT_USERNAME)
    args = parser.parse_args()

    load_env_file()
    tg = TelegramClient(str(SESSION_PATH), api_id(), api_hash())
    await tg.connect()
    bot = await tg.get_entity(args.bot)

    sent = await tg.send_message(bot, args.payload)
    print(f"[{datetime.now(timezone.utc).isoformat()}] Enviado: {args.payload}")
    print(f"msg_id={sent.id}")

    deadline = asyncio.get_event_loop().time() + args.timeout
    last_id = sent.id
    seen = set()

    while asyncio.get_event_loop().time() < deadline:
        async for m in tg.iter_messages(bot, min_id=last_id, reverse=True):
            if m.id in seen or m.out:
                continue
            seen.add(m.id)
            text = m.text or m.message or ""
            if not text.strip():
                continue
            ts = m.date.isoformat() if m.date else "?"
            print(f"\n[{ts}] BOT:\n{text[:1500]}")
            if is_approved(text):
                print("\nRESULT=APROVADA")
                await tg.disconnect()
                return 0
            if is_terminal_fail(text):
                print("\nRESULT=FALHA")
                await tg.disconnect()
                return 2
        await asyncio.sleep(5)

    print(f"\nRESULT=TIMEOUT após {args.timeout}s")
    await tg.disconnect()
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
