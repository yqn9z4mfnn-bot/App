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

No Telegram: envie o <b>número</b> (`38991121276`) → o bot gera o link JWT → varredura → `/recarga` → cartão (`NUMERO|MM|AAAA|CVV`).

Também aceita o link JWT direto.

Recarga via **API JavaScript** (tokenização Eldorado + pagamento + SSE).

Gerador de link (padrão):

```bash
CLARO_LINK_API=https://sarcastic-pertinaciously-shawnda.ngrok-free.dev
```
