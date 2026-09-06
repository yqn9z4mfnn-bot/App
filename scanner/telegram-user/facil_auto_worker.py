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
    is_confirm_prompt,
    parse_payload,
    parse_pedido_id,
    payload_target,
    response_matches_target,
)
from group_close import close_order_in_group, pedido_ja_feita
from worker_rules import (
    allowed_group_click,
    decide_next_action,
    error_fingerprint,
    is_reivindicar_label,
    next_after_bot_result,
)

STATE_FILE = DATA_DIR / "facil-auto-worker.json"
CURRENT_FILE = DATA_DIR / "worker-current.json"
LOCK_FILE = DATA_DIR / "facil-auto-worker.lock"
MIN_SEND_GAP_SEC = 45
IDLE_POLL_SEC = 60
RETRY_WAIT_SEC = 60
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


async def list_open_orders(g, tg, attendee=ATTENDEE):
    """Todos os pedidos abertos (PROCESSANDO ou confirmação) do atendente."""
    open_orders = []
    async for m in tg.iter_messages(g, limit=80):
        text = m.text or ""
        if attendee not in text:
            continue
        if is_feita_final(text):
            continue
        if "PROCESSANDO" not in text and not is_confirm_prompt(text):
            continue
        pedido = parse_pedido_id(text)
        payload = parse_payload(text)
        if pedido:
            open_orders.append((pedido, payload, m.id))
    return open_orders


async def processing_pedido_ids(g, tg, limit=200):
    ids = set()
    async for m in tg.iter_messages(g, limit=limit):
        text = m.text or ""
        if "PROCESSANDO" not in text and not is_feita_final(text):
            continue
        pid = parse_pedido_id(text)
        if pid:
            ids.add(pid)
    return ids


async def list_stray_processing(g, tg, own_pedido_id=None, attendee=ATTENDEE):
    """PROCESSANDO no nosso nome que NÃO é o pedido ativo do worker."""
    stray = []
    for pedido, payload, msg_id in await list_open_orders(g, tg, attendee):
        if pedido == own_pedido_id:
            continue
        stray.append((pedido, payload, msg_id))
    return stray


async def find_claimable_claro(g, tg, exclude_pedidos=None, limit=300):
    exclude = set(exclude_pedidos or [])
    already_processing = await processing_pedido_ids(g, tg)
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
        if any("Cancelar" in lb for lb in labels) and not any("Reivindicar" in lb for lb in labels):
            continue
        pid = parse_pedido_id(text)
        if pid and (pid in exclude or pid in already_processing):
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
    still_open = await list_open_orders(g, tg)
    if still_open:
        log(f"ABORT claim: {len(still_open)} pedido(s) ainda aberto(s)")
        return None, None, None

    candidates = await find_claimable_claro(g, tg)
    if not candidates:
        return None, None, None

    _, message, pedido_id = candidates[-1]

    # Revalida msg imediatamente antes do clique
    message = await tg.get_messages(g, ids=message.id)
    labels = [getattr(b, "text", "") for row in (message.buttons or []) for b in row]
    claim_label = next((lb for lb in labels if is_reivindicar_label(lb)), None)
    if not claim_label:
        log(f"Sem botão Reivindicar em {pedido_id} (msg {message.id}) — abortando")
        return None, None, None

    text_pre = message.text or ""
    if "PROCESSANDO" in text_pre or ATTENDEE in text_pre:
        log(f"Pedido {pedido_id} já reivindicado/PROCESSANDO — abortando")
        return None, None, None

    still_open = await list_open_orders(g, tg)
    if still_open:
        log(f"ABORT claim pré-clique: grupo não está limpo")
        return None, None, None

    if not allowed_group_click(claim_label):
        log(f"RECUSADO clique '{claim_label}'")
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
    """Só considera ocupado se há recarga em andamento de verdade."""
    async for m in tg.iter_messages(bot, limit=limit):
        if m.out:
            continue
        text = m.text or ""
        if exclude_target and response_matches_target(text, exclude_target):
            continue
        if classify_bot_response(text) == "approved":
            continue
        if re.search(
            r"Gerando login|Aguardando checkout|Aguardando navegador|"
            r"Verificando fila do navegador|Consultando saldo|"
            r"Limpando cart[oõ]es|Preparando",
            text,
            re.I,
        ):
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
            if after_id and m.id <= after_id:
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
            seen_texts.add(text)
            log(f"BOT [{kind}] {target}: {text[:280].replace(chr(10), ' | ')}")
            return kind, text

        await asyncio.sleep(2)

    return "timeout", ""


async def bot_state_for_target(tg, bot, target, limit=20):
    """Prefere APROVADA se existir para o número (não fica preso em negada antiga)."""
    kinds = []
    async for m in tg.iter_messages(bot, limit=limit):
        if m.out:
            continue
        text = m.text or ""
        if not response_matches_target(text, target):
            continue
        kinds.append((classify_bot_response(text), text))
    for kind, text in kinds:
        if kind == "approved":
            return "approved", text
    for kind, text in kinds:
        if kind in ("3ds", "denied", "fail", "fail_login"):
            return kind, text[:120]
    for kind, text in kinds:
        if kind == "progress":
            return "progress", text[:120]
    return "idle", ""


async def bot_active_targets(tg, bot, limit=20):
    targets = set()
    async for m in tg.iter_messages(bot, limit=limit):
        if m.out:
            continue
        text = m.text or ""
        kind = classify_bot_response(text)
        if kind not in ("progress", "approved"):
            continue
        digits = re.findall(r"\d{10,11}", text.replace("`", ""))
        targets.update(digits)
    return targets


async def acquire_order(g, tg, bot):
    current = load_current_pedido()
    open_raw = await list_open_orders(g, tg)
    open_orders = [{"pedido_id": p, "payload": pay, "msg_id": mid} for p, pay, mid in open_raw]
    current_id = current["pedido_id"] if current else None
    bot_targets = await bot_active_targets(tg, bot)

    action, resume_id = decide_next_action(open_orders, current_id, bot_targets)

    if action == "resume":
        row = next((o for o in open_orders if o["pedido_id"] == resume_id), None)
        if not row:
            return None, None
        save_current_pedido(row["pedido_id"], row["payload"], row["msg_id"])
        log(f"Retomando {row['pedido_id']} → {row['payload']} (sem novo Reivindicar)")
        return row["payload"], row["pedido_id"]

    if action == "block":
        for o in open_orders:
            log(f"Aberto: {o['pedido_id']} → {o['payload']} (msg {o['msg_id']})")
        log(f"BLOQUEADO: {len(open_orders)} pedido(s) aberto(s) — NÃO reivindica novo")
        return None, None

    busy, hint = await bot_has_active_job(tg, bot)
    if busy:
        log(f"Bot ocupado — aguardando antes de reivindicar ({hint})")
        return None, None

    payload, pedido, _msg_id = await claim_one_claro(g, tg)
    if payload:
        after = await list_open_orders(g, tg)
        if len(after) > 1:
            log(f"ALERTA: {len(after)} abertos após Reivindicar — não envia, bloqueia")
            return None, None
        log(f"Reivindicado {pedido} → {payload}")
    return payload, pedido


async def process_one_order(g, tg, bot, payload, pedido_id, max_cycles=50):
    """Qualquer coisa ≠ APROVADA: espera 60s e reenvia o mesmo número. Mesmo erro 2x → para."""
    target = payload_target(payload)
    last_fp = None

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
        log(f"Bot processando {target} — aguardando resultado")
        kind, text = await wait_bot_reply(tg, bot, 0, target, timeout=600)
        if kind == "approved":
            return await _apply_terminal(g, tg, payload, pedido_id, target, kind, text, None)
        state, hint = kind, text

    if state not in ("idle", "progress", "approved"):
        last_fp = error_fingerprint(state, hint, target)
        log(f"{state} em {target} (não APROVADA) — {RETRY_WAIT_SEC}s e reenvia o mesmo número")
        await asyncio.sleep(RETRY_WAIT_SEC)
        try:
            if not tg.is_connected():
                await tg.connect()
        except Exception as exc:
            log(f"Reconnect: {exc}")
            await tg.connect()

    for cycle in range(1, max_cycles + 1):
        busy, busy_hint = await bot_has_active_job(tg, bot, exclude_target=target)
        if busy:
            log(f"Outro job no bot — aguardando 15s ({busy_hint})")
            await asyncio.sleep(15)
            continue

        others = [o for o in await list_open_orders(g, tg) if o[0] != pedido_id]
        if others:
            log(f"ABORT envio: outro pedido aberto {others[0][0]}")
            return "blocked"

        log(f"=== Envio {cycle} | pedido={pedido_id} | {payload} ===")
        if not tg.is_connected():
            await tg.connect()
        sent = await tg.send_message(bot, payload)
        log(f"Enviado: {payload}")

        kind, text = await wait_bot_reply(tg, bot, sent.id, target, timeout=600)
        action = await _apply_terminal(g, tg, payload, pedido_id, target, kind, text, last_fp)
        if action == "retry":
            last_fp = error_fingerprint(kind if kind != "timeout" else "timeout", text, target)
            continue
        return action

    return "failed"


async def _apply_terminal(g, tg, payload, pedido_id, target, kind, text, last_fp):
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
        kind = "timeout"
        text = text or "Timeout"

    fp = error_fingerprint(kind, text, target)
    decision = next_after_bot_result(kind, fp, last_fp)
    log(f"Erro {target}: {fp} → {decision}")

    if decision == "halt":
        log(f"PARADO: mesmo erro 2x no número {target} — não reivindica mais")
        save_state({
            "result": "halt_same_error",
            "payload": payload,
            "pedido_id": pedido_id,
            "error": fp,
            "at": datetime.now(timezone.utc).isoformat(),
        })
        return "halt_same_error"

    log(f"Aguarda {RETRY_WAIT_SEC}s e reenvia o mesmo número {target}")
    await asyncio.sleep(RETRY_WAIT_SEC)
    try:
        if not tg.is_connected():
            await tg.connect()
    except Exception as exc:
        log(f"Sessão Telegram caiu no wait, reconectando: {exc}")
        await tg.connect()
    return "retry"


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
                    if await pedido_ja_feita(g, tg, pedido_id_retry):
                        pending_confirm = None
                        log(f"Pedido {pedido_id_retry} já Feita — seguindo")
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

            if result == "halt_same_error":
                log("PARADO: não reivindica mais nenhum pedido")
                exit_code = 2
                break

            if result == "blocked":
                log("Envio bloqueado — aguardando grupo limpo")
                await asyncio.sleep(idle_poll)
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
