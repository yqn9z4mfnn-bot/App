#!/usr/bin/env python3
"""Fechar pedido no grupo: Feita → Confirmar (2 passos)."""
import asyncio
import re

from facil_group import is_confirm_prompt, is_feita_final, parse_pedido_id


def _btn_labels(msg):
    return [getattr(b, "text", "") for row in (msg.buttons or []) for b in row]


async def find_processing_msg(g, tg, pedido_id, limit=120):
    async for m in tg.iter_messages(g, limit=limit):
        text = m.text or ""
        if pedido_id in text and "PROCESSANDO" in text:
            return m
    return None


async def find_confirm_msg(g, tg, pedido_id=None, anchor_msg_id=None, limit=30):
    if anchor_msg_id:
        m = await tg.get_messages(g, ids=anchor_msg_id)
        if m and is_confirm_prompt(m.text) and m.buttons:
            return m

    async for m in tg.iter_messages(g, limit=limit):
        text = m.text or ""
        if not is_confirm_prompt(text) or not m.buttons:
            continue
        if pedido_id and pedido_id in text:
            return m
        if pedido_id is None:
            return m
    return None


async def click_confirm(msg, pedido_id="?"):
    for row in msg.buttons:
        for b in row:
            label = getattr(b, "text", "")
            if re.match(r"^✅\s*Confirmar$", label.strip()) or label.strip() == "✅ Confirmar":
                await msg.click(text=label)
                return True
    for row in msg.buttons:
        for b in row:
            label = getattr(b, "text", "")
            if "Confirmar" in label and "Cancelar" not in label:
                await msg.click(text=label)
                return True
    return False


async def close_order_in_group(g, tg, pedido_id, log=print):
    """Clica Feita + Confirmar. Retorna True só com status final Feita."""
    msg = await find_processing_msg(g, tg, pedido_id)
    if msg and is_feita_final(msg.text or ""):
        log(f"Pedido {pedido_id} já está Feita no grupo")
        return True

    anchor_id = msg.id if msg else None

    if msg and msg.buttons and any("Feita" in lb for lb in _btn_labels(msg)):
        for row in msg.buttons:
            for b in row:
                if "Feita" in getattr(b, "text", ""):
                    await msg.click(text=b.text)
                    log(f"Clicou Feita pedido {pedido_id} (msg {msg.id})")
                    anchor_id = msg.id
                    break

    # Diálogo "Tem certeza…" aparece na MESMA msg (editada) — sem pedido_id no texto
    for attempt in range(40):
        await asyncio.sleep(0.5)

        if anchor_id:
            updated = await tg.get_messages(g, ids=anchor_id)
            if updated:
                if is_feita_final(updated.text or ""):
                    log(f"Grupo fechado {pedido_id} (msg {anchor_id})")
                    return True
                if is_confirm_prompt(updated.text) and updated.buttons:
                    if await click_confirm(updated, pedido_id):
                        log(f"Clicou Confirmar pedido {pedido_id} (msg {anchor_id})")
                        await asyncio.sleep(1.5)
                        final = await tg.get_messages(g, ids=anchor_id)
                        if final and is_feita_final(final.text or ""):
                            log(f"Grupo fechado {pedido_id}")
                            return True

        confirm = await find_confirm_msg(g, tg, pedido_id=None, limit=15)
        if confirm and confirm.buttons:
            if await click_confirm(confirm, pedido_id):
                log(f"Clicou Confirmar pedido {pedido_id} (msg {confirm.id})")
                await asyncio.sleep(1.5)
                check = await tg.get_messages(g, ids=confirm.id)
                if check and is_feita_final(check.text or ""):
                    log(f"Grupo fechado {pedido_id}")
                    return True

        # pedido pode aparecer só após confirmar
        async for m in tg.iter_messages(g, limit=40):
            text = m.text or ""
            if pedido_id in text and is_feita_final(text):
                log(f"Pedido {pedido_id} já Feita (msg {m.id})")
                return True

        if attempt % 10 == 9:
            log(f"Aguardando Confirmar {pedido_id}… ({attempt + 1}/40)")

    log(f"FALHA: Confirmar não concluído para {pedido_id}")
    return False
