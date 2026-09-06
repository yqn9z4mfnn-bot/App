#!/usr/bin/env python3
"""Reivindica pedido Claro mais antigo com botão Reivindicar."""
import argparse
import asyncio
import re

from telethon import TelegramClient

from config import SESSION_PATH, api_id, api_hash, load_env_file

GROUP_ID = 2841351530


async def find_claimable(g, tg, operator="Claro", limit=300):
    candidates = []
    async for m in tg.iter_messages(g, limit=limit):
        text = m.text or ""
        if "Novo Pedido de Recarga" not in text:
            continue
        if not re.search(rf"\*\*Operadora:\*\*\s*{re.escape(operator)}", text, re.I):
            continue
        labels = [getattr(b, "text", "") for row in (m.buttons or []) for b in row]
        if not any("Reivindicar" in lb for lb in labels):
            continue
        match = re.search(r"`([a-f0-9]{20,})`", text)
        candidates.append((m.date, m, match.group(1) if match else None, labels))
    return candidates


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--operator", default="Claro")
    parser.add_argument("--limit", type=int, default=300)
    args = parser.parse_args()

    load_env_file()
    tg = TelegramClient(str(SESSION_PATH), api_id(), api_hash())
    await tg.connect()
    g = await tg.get_entity(GROUP_ID)

    candidates = await find_claimable(g, tg, args.operator, args.limit)
    if not candidates:
        print("NENHUM pedido", args.operator, "com Reivindicar")
        await tg.disconnect()
        return 1

    date, message, pedido_id, labels = candidates[-1]
    print("Alvo:", pedido_id, "msg_id=", message.id, "date=", date.isoformat())

    clicked = False
    for label in labels:
        if "Reivindicar" in label:
            try:
                if "Cancelar" in label:
                    continue
                await message.click(text=label)
                clicked = True
                break
            except Exception:
                pass
    if not clicked:
        print("Não clicou Reivindicar (nunca usa click(0) — evitaria Cancelar)")

    await asyncio.sleep(3)
    updated = await tg.get_messages(g, ids=message.id)
    print("--- APOS REIVINDICAR ---")
    print(updated.text or "")
    btn_labels = [getattr(b, "text", "") for row in (updated.buttons or []) for b in row]
    print("Botoes:", btn_labels)
    await tg.disconnect()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
