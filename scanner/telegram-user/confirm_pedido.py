#!/usr/bin/env python3
"""Clica Confirmar (e Feita se necessário) no grupo Fácil — sem reenviar ao bot."""
import argparse
import asyncio
import sys

from telethon import TelegramClient

from config import SESSION_PATH, api_id, api_hash, load_env_file
from facil_group import GROUP_ID


async def click_confirm_on_message(tg, g, msg_id=None, pedido=None):
    if msg_id:
        m = await tg.get_messages(g, ids=msg_id)
        if not m:
            print(f"Mensagem {msg_id} não encontrada")
            return False
        candidates = [m]
    else:
        candidates = []
        async for m in tg.iter_messages(g, limit=80):
            t = m.text or ""
            if "Tem certeza" not in t:
                continue
            if pedido and pedido not in t:
                continue
            candidates.append(m)

    for m in candidates:
        t = m.text or ""
        print(f"msg_id={m.id} preview={t[:120].replace(chr(10), ' | ')}")
        if not m.buttons:
            continue
        labels = [getattr(b, "text", "") for row in m.buttons for b in row]
        print("Botoes:", labels)
        for row in m.buttons:
            for b in row:
                label = getattr(b, "text", "")
                if "Confirmar" in label:
                    await m.click(text=label)
                    print("Confirmar clicado")
                    await asyncio.sleep(3)
                    updated = await tg.get_messages(g, ids=m.id)
                    print("--- APOS CONFIRMAR ---")
                    print(updated.text or "(sem texto)")
                    btn_labels = [getattr(x, "text", "") for row in (updated.buttons or []) for x in row]
                    print("Botoes:", btn_labels)
                    return True
    return False


async def click_feita_if_needed(tg, g, pedido):
    async for m in tg.iter_messages(g, limit=120):
        t = m.text or ""
        if pedido not in t:
            continue
        if "PROCESSANDO" not in t or not m.buttons:
            continue
        labels = [getattr(b, "text", "") for row in m.buttons for b in row]
        if not any("Feita" in lb for lb in labels):
            continue
        for row in m.buttons:
            for b in row:
                if "Feita" in getattr(b, "text", ""):
                    await m.click(text=b.text)
                    print(f"Feita clicada msg_id={m.id}")
                    await asyncio.sleep(2)
                    return True
    return False


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--msg-id", type=int, help="ID da mensagem de confirmação")
    parser.add_argument("--pedido", help="ID do pedido (hex)")
    parser.add_argument("--feita-first", action="store_true", help="Clica Feita antes se ainda PROCESSANDO")
    args = parser.parse_args()

    if not args.msg_id and not args.pedido:
        print("Informe --msg-id ou --pedido")
        return 1

    load_env_file()
    tg = TelegramClient(str(SESSION_PATH), api_id(), api_hash())
    await tg.connect()
    g = await tg.get_entity(GROUP_ID)

    if args.feita_first and args.pedido:
        await click_feita_if_needed(tg, g, args.pedido)

    ok = await click_confirm_on_message(tg, g, msg_id=args.msg_id, pedido=args.pedido)
    await tg.disconnect()
    if ok:
        print("OK: confirmado")
        return 0
    print("FALHA: Confirmar não encontrado/clicado")
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
