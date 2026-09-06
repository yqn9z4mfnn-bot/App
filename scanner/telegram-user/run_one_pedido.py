#!/usr/bin/env python3
"""Reivindica (ou usa payload informado), envia 1x ao bot, aguarda, fecha no grupo se aprovada."""
import argparse
import asyncio

from telethon import TelegramClient

from config import SESSION_PATH, api_id, api_hash, load_env_file
from facil_group import BOT_USERNAME, GROUP_ID, classify_bot_response, is_actionable_response
from facil_auto_worker import claim_oldest_claro


async def wait_bot(tg, bot, after_id, timeout=600):
    deadline = asyncio.get_event_loop().time() + timeout
    seen = set()
    anchor = None
    while asyncio.get_event_loop().time() < deadline:
        ids = []
        if anchor:
            ids.append(anchor)
        async for m in tg.iter_messages(bot, limit=8):
            if m.out:
                continue
            if m.id <= after_id and not anchor:
                continue
            if anchor is None:
                anchor = m.id
            if m.id not in ids:
                ids.append(m.id)
        for mid in ids:
            u = await tg.get_messages(bot, ids=mid)
            text = u.text or ""
            if not text or text in seen:
                continue
            kind = classify_bot_response(text)
            if kind == "progress":
                seen.add(text)
                preview = text[:200].replace("\n", " | ")
                print(f"[progress] {preview}")
                continue
            if is_actionable_response(text):
                print(f"[{kind}] {text}")
                return kind, text
        await asyncio.sleep(2)
    return "timeout", ""


async def mark_feita_confirm(tg, g, pedido):
    proc = None
    async for m in tg.iter_messages(g, limit=100):
        t = m.text or ""
        if pedido in t and "PROCESSANDO" in t:
            proc = m
            break
    if proc and proc.buttons:
        for row in proc.buttons:
            for b in row:
                if "Feita" in getattr(b, "text", ""):
                    await proc.click(text=b.text)
                    print("Clicou Feita")
                    await asyncio.sleep(2)
                    break

    async for m in tg.iter_messages(g, limit=25):
        t = m.text or ""
        if "Tem certeza" in t and m.buttons:
            for row in m.buttons:
                for b in row:
                    if "Confirmar" in getattr(b, "text", ""):
                        await m.click(text=b.text)
                        print("Clicou Confirmar")
                        await asyncio.sleep(2)
                        return True
    return False


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload")
    parser.add_argument("--pedido")
    parser.add_argument("--claim", action="store_true")
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()

    load_env_file()
    tg = TelegramClient(str(SESSION_PATH), api_id(), api_hash())
    await tg.connect()
    g = await tg.get_entity(GROUP_ID)
    bot = await tg.get_entity(BOT_USERNAME)

    payload = args.payload
    pedido = args.pedido
    if args.claim or not payload:
        payload, pedido, _ = await claim_oldest_claro(g, tg)
        if not payload:
            print("Sem pedido Claro disponível")
            await tg.disconnect()
            return 1
        print(f"Reivindicado {pedido} → {payload}")

    print(f"Enviando 1x: {payload}")
    sent = await tg.send_message(bot, payload)
    kind, _text = await wait_bot(tg, bot, sent.id, timeout=args.timeout)
    print("RESULTADO:", kind)

    if kind == "approved" and pedido:
        await mark_feita_confirm(tg, g, pedido)
        print("Fechado no grupo")

    await tg.disconnect()
    return 0 if kind == "approved" else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
