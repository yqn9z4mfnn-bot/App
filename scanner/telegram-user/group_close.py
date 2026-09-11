#!/usr/bin/env python3
"""Fechar pedido no grupo: Feita → Confirmar (2 passos). Nunca Cancelar."""
import asyncio

from facil_group import is_confirm_prompt, is_feita_final
from worker_rules import allowed_group_click, is_confirm_label, is_feita_label


def _btn_labels(msg):
    return [getattr(b, "text", "") for row in (msg.buttons or []) for b in row]


async def safe_click(msg, label, log=print):
    if is_cancel_label_or_blocked(label):
        log(f"RECUSADO clique em '{label}' (nunca cancela)")
        return False
    await msg.click(text=label)
    return True


def is_cancel_label_or_blocked(label):
    return not allowed_group_click(label)


async def _msg_by_id(g, tg, msg_id):
    if not msg_id:
        return None
    try:
        return await tg.get_messages(g, ids=msg_id)
    except Exception:
        return None


async def pedido_ja_feita(g, tg, pedido_id, anchor_msg_id=None, limit=500):
    anchor = await _msg_by_id(g, tg, anchor_msg_id)
    if anchor and pedido_id in (anchor.text or "") and is_feita_final(anchor.text or ""):
        return True
    async for m in tg.iter_messages(g, limit=limit):
        text = m.text or ""
        if pedido_id in text and is_feita_final(text):
            return True
    return False


async def find_processing_msg(g, tg, pedido_id, anchor_msg_id=None, limit=500):
    anchor = await _msg_by_id(g, tg, anchor_msg_id)
    if anchor and pedido_id in (anchor.text or ""):
        return anchor
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


async def click_confirm(msg, pedido_id="?", log=print):
    if not msg.buttons:
        return False
    for row in msg.buttons:
        for b in row:
            label = getattr(b, "text", "")
            if is_confirm_label(label):
                return await safe_click(msg, label, log=log)
    return False


async def close_order_in_group(g, tg, pedido_id, log=print, anchor_msg_id=None):
    """Clica Feita + Confirmar. Retorna True só com status final Feita."""
    if await pedido_ja_feita(g, tg, pedido_id, anchor_msg_id=anchor_msg_id):
        log(f"Pedido {pedido_id} já está Feita no grupo")
        return True

    msg = await find_processing_msg(g, tg, pedido_id, anchor_msg_id=anchor_msg_id)

    anchor_id = anchor_msg_id or (msg.id if msg else None)

    if msg and msg.buttons:
        for row in msg.buttons:
            for b in row:
                label = getattr(b, "text", "")
                if is_feita_label(label):
                    if await safe_click(msg, label, log=log):
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
                    if await click_confirm(updated, pedido_id, log=log):
                        log(f"Clicou Confirmar pedido {pedido_id} (msg {anchor_id})")
                        await asyncio.sleep(1.5)
                        final = await tg.get_messages(g, ids=anchor_id)
                        if final and is_feita_final(final.text or ""):
                            log(f"Grupo fechado {pedido_id}")
                            return True

        confirm = await find_confirm_msg(
            g, tg, pedido_id=pedido_id, anchor_msg_id=anchor_id, limit=80
        )
        if confirm and confirm.buttons:
            if await click_confirm(confirm, pedido_id, log=log):
                log(f"Clicou Confirmar pedido {pedido_id} (msg {confirm.id})")
                await asyncio.sleep(1.5)
                check = await tg.get_messages(g, ids=confirm.id)
                if check and is_feita_final(check.text or ""):
                    log(f"Grupo fechado {pedido_id}")
                    return True

        if anchor_id:
            final_anchor = await tg.get_messages(g, ids=anchor_id)
            if final_anchor and pedido_id in (final_anchor.text or "") and is_feita_final(final_anchor.text or ""):
                log(f"Pedido {pedido_id} já Feita (msg {anchor_id})")
                return True

        async for m in tg.iter_messages(g, limit=500):
            text = m.text or ""
            if pedido_id in text and is_feita_final(text):
                log(f"Pedido {pedido_id} já Feita (msg {m.id})")
                return True

        if attempt % 10 == 9:
            log(f"Aguardando Confirmar {pedido_id}… ({attempt + 1}/40)")

    log(f"FALHA: Confirmar não concluído para {pedido_id}")
    return False
