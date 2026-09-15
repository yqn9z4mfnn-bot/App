import os
from pathlib import Path

DATA_DIR = Path(os.environ.get('TELEGRAM_USER_DATA', '/root/.local/share/telegram-user'))
SESSION_PATH = DATA_DIR / 'session'
OTP_FILE = DATA_DIR / 'otp.txt'
PASSWORD_FILE = DATA_DIR / 'password.txt'
STATUS_FILE = DATA_DIR / 'status.json'


def load_env_file(path=None):
    env_path = path or Path(__file__).resolve().parent / '.env'
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def require_env(name):
    value = os.environ.get(name, '').strip()
    if not value:
        raise SystemExit(f'Variável obrigatória ausente: {name} (preencha telegram-user/.env)')
    return value


def api_id():
    return int(require_env('TELEGRAM_API_ID'))


def api_hash():
    return require_env('TELEGRAM_API_HASH')


def phone():
    return require_env('TELEGRAM_PHONE')


def telegram_proxy():
    """Proxy MTProto (obrigatório na nuvem Cursor — DC direto costuma falhar)."""
    enabled = os.environ.get('TELEGRAM_PROXY_ENABLED', '').strip().lower()
    if enabled not in ('1', 'true', 'yes', 'on'):
        return None
    server = os.environ.get('TELEGRAM_PROXY_SERVER', '').strip()
    port = int(os.environ.get('TELEGRAM_PROXY_PORT', '0') or 0)
    if not server or not port:
        return None
    proxy_type = os.environ.get('TELEGRAM_PROXY_TYPE', 'http').strip().lower()
    username = os.environ.get('TELEGRAM_PROXY_USERNAME', '').strip() or None
    password = os.environ.get('TELEGRAM_PROXY_PASSWORD', '').strip() or None
    return (proxy_type, server, port, True, username, password)


def telegram_client(**kwargs):
    from telethon import TelegramClient

    proxy = telegram_proxy()
    if proxy:
        kwargs.setdefault('proxy', proxy)
    return TelegramClient(str(SESSION_PATH), api_id(), api_hash(), **kwargs)
