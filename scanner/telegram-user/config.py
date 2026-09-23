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


def _env_truthy(name, default='0'):
    raw = os.environ.get(name, default)
    return str(raw).strip().lower() in ('1', 'true', 'yes', 'on')


def telethon_proxy():
    """
    SOCKS/HTTP para MTProto (Telethon). Worker na nuvem costuma precisar de proxy
    mesmo com PROXY_ENABLED=0 no browser — use TELEGRAM_PROXY_ENABLED=1 no start.
    """
    if not _env_truthy('TELEGRAM_PROXY_ENABLED', os.environ.get('PROXY_ENABLED', '0')):
        return None
    host = (os.environ.get('TELEGRAM_PROXY_SERVER') or os.environ.get('PROXY_SERVER') or '').strip()
    port_raw = (os.environ.get('TELEGRAM_PROXY_PORT') or os.environ.get('PROXY_PORT') or '').strip()
    if not host or not port_raw:
        return None
    try:
        port = int(port_raw)
    except ValueError:
        return None
    ptype = (os.environ.get('TELEGRAM_PROXY_TYPE') or 'socks5').strip().lower()
    user = (os.environ.get('TELEGRAM_PROXY_USERNAME') or os.environ.get('PROXY_USERNAME') or '').strip() or None
    password = (
        os.environ.get('TELEGRAM_PROXY_PASSWORD') or os.environ.get('PROXY_PASSWORD') or ''
    ).strip() or None
    return (ptype, host, port, True, user, password)


def telegram_client(session_path=None):
    from telethon import TelegramClient

    path = str(session_path or SESSION_PATH)
    proxy = telethon_proxy()
    return TelegramClient(path, api_id(), api_hash(), proxy=proxy)
