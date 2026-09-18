#!/usr/bin/env python3
"""Clica Confirmar (e Feita se necessário) no grupo Fácil — sem reenviar ao bot."""
import argparse
import asyncio

from telethon import TelegramClient

from config import SESSION_PATH, api_id, api_hash, load_env_file
from facil_group import GROUP_ID
from group_close import close_order_in_group


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pedido", required=True, help="ID pedido grupo (hex)")
    args = parser.parse_args()

    load_env_file()
    tg = TelegramClient(str(SESSION_PATH), api_id(), api_hash())
    await tg.connect()
    g = await tg.get_entity(GROUP_ID)

    ok = await close_order_in_group(g, tg, args.pedido, log=print)
    await tg.disconnect()
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
