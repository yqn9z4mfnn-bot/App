#!/usr/bin/env python3
"""Login MTProto (conta de usuário) com sessão persistente."""
import argparse
import asyncio
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError

from config import (
    DATA_DIR,
    OTP_FILE,
    PASSWORD_FILE,
    SESSION_PATH,
    STATUS_FILE,
    api_hash,
    api_id,
    load_env_file,
    phone,
)


def write_status(**fields):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        'updated_at': datetime.now(timezone.utc).isoformat(),
        **fields,
    }
    STATUS_FILE.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def client():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return TelegramClient(str(SESSION_PATH), api_id(), api_hash())


async def cmd_status():
    async with client() as tg:
        if not await tg.is_user_authorized():
            write_status(authorized=False, message='Sessão não autorizada')
            print('OFF — não logado')
            return 1
        me = await tg.get_me()
        write_status(
            authorized=True,
            user_id=me.id,
            username=me.username,
            first_name=me.first_name,
            phone=me.phone,
        )
        label = f'@{me.username}' if me.username else (me.first_name or str(me.id))
        print(f'ON — logado como {label} (id {me.id})')
        return 0


async def cmd_request_code():
    async with client() as tg:
        if await tg.is_user_authorized():
            me = await tg.get_me()
            label = f'@{me.username}' if me.username else str(me.id)
            print(f'Já logado como {label}')
            return 0
        sent = await tg.send_code_request(phone())
        OTP_FILE.unlink(missing_ok=True)
        PASSWORD_FILE.unlink(missing_ok=True)
        write_status(
            authorized=False,
            awaiting='otp',
            phone=phone(),
            phone_code_hash=sent.phone_code_hash,
        )
        print(f'Código enviado para {phone()}')
        print(f'Informe o OTP: python3 auth.py sign-in CODIGO')
        print(f'ou: echo CODIGO > {OTP_FILE}')
        return 0


async def cmd_sign_in(code=None, wait_seconds=0):
    code = (code or '').strip()
    if not code and wait_seconds > 0:
        print(f'Aguardando OTP em {OTP_FILE} ({wait_seconds}s)...')
        deadline = time.time() + wait_seconds
        while time.time() < deadline:
            if OTP_FILE.is_file():
                code = OTP_FILE.read_text(encoding='utf-8').strip()
                if code:
                    OTP_FILE.unlink(missing_ok=True)
                    break
            await asyncio.sleep(1)
    if not code:
        raise SystemExit('Informe o código: auth.py sign-in 12345')

    status = {}
    if STATUS_FILE.is_file():
        try:
            status = json.loads(STATUS_FILE.read_text(encoding='utf-8'))
        except json.JSONDecodeError:
            status = {}

    async with client() as tg:
        if await tg.is_user_authorized():
            me = await tg.get_me()
            print(f'Já logado como {me.username or me.id}')
            return 0

        phone_hash = status.get('phone_code_hash')
        if not phone_hash:
            raise SystemExit('Rode antes: python3 auth.py request-code')

        try:
            await tg.sign_in(phone=phone(), code=code, phone_code_hash=phone_hash)
        except SessionPasswordNeededError:
            password = (PASSWORD_FILE.read_text(encoding='utf-8').strip() if PASSWORD_FILE.is_file() else '')
            password = password or os.environ.get('TELEGRAM_2FA_PASSWORD', '').strip()
            if not password:
                write_status(authorized=False, awaiting='2fa')
                raise SystemExit(
                    f'Conta com 2FA. Use: TELEGRAM_2FA_PASSWORD=... python3 auth.py sign-in-2fa SENHA\n'
                    f'ou: echo SENHA > {PASSWORD_FILE} && python3 auth.py sign-in-2fa'
                )
            await tg.sign_in(password=password)

        me = await tg.get_me()
        write_status(
            authorized=True,
            user_id=me.id,
            username=me.username,
            first_name=me.first_name,
            phone=me.phone,
            awaiting=None,
        )
        label = f'@{me.username}' if me.username else (me.first_name or str(me.id))
        print(f'Login OK — {label} (id {me.id})')
        print(f'Sessão salva em {SESSION_PATH}.session')
        return 0


async def cmd_sign_in_2fa(password=None):
    password = (password or '').strip()
    if not password and PASSWORD_FILE.is_file():
        password = PASSWORD_FILE.read_text(encoding='utf-8').strip()
    password = password or os.environ.get('TELEGRAM_2FA_PASSWORD', '').strip()
    if not password:
        raise SystemExit('Informe a senha 2FA')

    async with client() as tg:
        await tg.sign_in(password=password)
        me = await tg.get_me()
        write_status(
            authorized=True,
            user_id=me.id,
            username=me.username,
            first_name=me.first_name,
            phone=me.phone,
            awaiting=None,
        )
        PASSWORD_FILE.unlink(missing_ok=True)
        print(f'2FA OK — logado como {me.username or me.id}')
        return 0


async def cmd_logout():
    async with client() as tg:
        await tg.log_out()
    for f in (STATUS_FILE, OTP_FILE, PASSWORD_FILE):
        f.unlink(missing_ok=True)
    session_file = Path(f'{SESSION_PATH}.session')
    session_file.unlink(missing_ok=True)
    print('Logout concluído')
    return 0


def main():
    load_env_file()
    parser = argparse.ArgumentParser(description='Login Telegram (conta de usuário)')
    sub = parser.add_subparsers(dest='cmd', required=True)

    sub.add_parser('status', help='Verifica se a sessão está ativa')
    sub.add_parser('request-code', help='Envia OTP para o telefone')
    p_sign = sub.add_parser('sign-in', help='Confirma OTP')
    p_sign.add_argument('code', nargs='?', help='Código recebido')
    p_sign.add_argument('--wait', type=int, default=0, help='Espera OTP em otp.txt')
    p_2fa = sub.add_parser('sign-in-2fa', help='Confirma senha 2FA')
    p_2fa.add_argument('password', nargs='?', help='Senha 2FA')
    sub.add_parser('logout', help='Encerra sessão')

    args = parser.parse_args()

    cmds = {
        'status': cmd_status,
        'request-code': cmd_request_code,
        'sign-in': lambda: cmd_sign_in(args.code, args.wait),
        'sign-in-2fa': lambda: cmd_sign_in_2fa(args.password),
        'logout': cmd_logout,
    }
    raise SystemExit(asyncio.run(cmds[args.cmd]()))


if __name__ == '__main__':
    main()
