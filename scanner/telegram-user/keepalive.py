#!/usr/bin/env python3
"""Mantém a sessão MTProto conectada (reconecta se cair)."""
import asyncio
import json
import signal
from datetime import datetime, timezone

from telethon import TelegramClient

from config import DATA_DIR, SESSION_PATH, STATUS_FILE, api_hash, api_id, load_env_file


running = True


def stop(*_):
    global running
    running = False


def write_status(**fields):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        'updated_at': datetime.now(timezone.utc).isoformat(),
        'keepalive': True,
        **fields,
    }
    STATUS_FILE.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


async def main():
    load_env_file()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    tg = TelegramClient(str(SESSION_PATH), api_id(), api_hash())
    await tg.connect()

    if not await tg.is_user_authorized():
        write_status(authorized=False, message='Não logado — rode auth.py request-code')
        print('ERRO: sessão não autorizada. Rode login primeiro.')
        await tg.disconnect()
        return 1

    me = await tg.get_me()
    label = f'@{me.username}' if me.username else (me.first_name or str(me.id))
    write_status(authorized=True, user_id=me.id, username=me.username, connected=True)
    print(f'Keepalive ON — {label} (id {me.id})')

    while running:
        try:
            if not tg.is_connected():
                await tg.connect()
            await tg.get_me()
            write_status(authorized=True, user_id=me.id, username=me.username, connected=True)
            await asyncio.sleep(30)
        except Exception as err:
            write_status(authorized=True, user_id=me.id, username=me.username, connected=False, error=str(err))
            print(f'Reconectando: {err}')
            await asyncio.sleep(5)

    await tg.disconnect()
    write_status(authorized=True, user_id=me.id, username=me.username, connected=False)
    print('Keepalive encerrado')
    return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
