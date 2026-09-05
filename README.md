# App

## Claro Recarga Scanner

Varredura de leitura a partir do link JWT (`?t=`) — número, valores, cartões (wallet Eldorado) e histórico.

```bash
cd scanner
node scan.mjs "https://clarorecarga.claro.com.br/minhaclaro_web/select-login?t=SEU_JWT"
node scan.mjs "SEU_JWT" --out resultado.json
node scan.mjs "SEU_JWT" --no-wallet   # só API Claro (mais rápido, evita 429)
```

Requer Node.js 18+. Documentação completa da API: `docs/CLARO_RECARGA_API_MAP.md`.

### Bot Telegram

Roda isolado em **appdata** (sem token/logs no projeto):

```bash
cd scanner
bash install-appdata.sh   # instala em ~/.local/share/linkclaro-bot e inicia
```

Comandos appdata:
- `~/.local/share/linkclaro-bot/run.sh` — iniciar
- `~/.local/share/linkclaro-bot/stop.sh` — parar
- `~/.local/share/linkclaro-bot/clear.sh` — limpar logs/PID

Token fica só em `~/.local/share/linkclaro-bot/.env` (chmod 600):

```bash
TELEGRAM_BOT_TOKEN=seu_token
```

Proxy desligado por padrão. Para gerador de link e API Claro via Smartproxy:

```bash
PROXY_ENABLED=1
PROXY_SERVER=proxy.smartproxy.net
PROXY_PORT=3120
PROXY_USERNAME=seu_usuario_area-BR
PROXY_PASSWORD=sua_senha
CLARO_LINK_TIMEOUT_MS=15000
```

O gerador de link (`fetch-claro-link`) e a API Claro (`http.mjs`) usam o mesmo proxy quando `PROXY_ENABLED=1`.

No Telegram:
- envie um **`.txt`** (um número por linha) → gera JWT, lê valores e **salva** (1 por vez)
- número avulso ou JWT → varredura normal, **não grava** no banco
- `/valores` ou `/valor 20` (ou só `20`) → o bot **envia o link** de um número que tem esse valor
- `/lista` — números salvos
- `/usar 3899…` / `/apagar 3899…` / `/scan 3899…`

Também aceita número avulso ou o link JWT direto. SQLite: `~/.local/share/linkclaro-bot/numbers.db`.

Recarga via **Playwright + Edge** (link JWT `select-login` → checkout Eldorado). Fallback API: `RECHARGE_MODE=api` no `.env`.

Automação local (porta 3000):

```bash
cd scanner
npm install
npm run automation
```

Variáveis úteis no `~/.local/share/linkclaro-bot/.env`:

```bash
AUTOMATION_API_URL=http://127.0.0.1:3000
BROWSER_NAME=edge
HEADLESS=false
RECHARGE_MODE=browser
```

Pasta de debug quando trava/timeout na gate: `~/.local/share/linkclaro-bot/debug/` (JSON + PNG).

Gerador de link (padrão):

```bash
CLARO_LINK_API=https://dayanes2lucas.ngrok.dev
```
