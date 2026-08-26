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

Token fica só em `~/.local/share/linkclaro-bot/.env` (chmod 600).

#### Recarga anti-fraude (automação Playwright)

A varredura continua **rápida via API**. A recarga com **cartão novo** pode usar a mesma automação Playwright (`server.js` + `automation.js`) que preenche o checkout real no navegador — evita `suspected fraud`.

No `.env` do bot:

```bash
TELEGRAM_BOT_TOKEN=...
AUTOMATION_API_URL=http://localhost:3000
RECHARGE_MODE=auto          # auto | browser | api
AUTOMATION_BROWSER=chromium # opcional
```

1. Suba a automação no PC (projeto com `server.js`, `automation.js`, `config.js`, Playwright instalado):

```bash
npm install
npx playwright install chromium
node server.js
```

2. Suba o bot (appdata ou `node telegram-bot.mjs`).

3. No Telegram: link JWT → `/recarga` → cartão novo → o bot chama `POST /api/session/start-web-link`.

| Modo | Comportamento |
|------|----------------|
| `auto` | Browser se `AUTOMATION_API_URL` definido; API para cartão salvo |
| `browser` | Sempre browser (cartão novo) |
| `api` | Sempre API direta (rápido, maior risco de fraude) |
