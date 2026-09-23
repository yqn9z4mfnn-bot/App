# Política: navegador, proxy e ambientes

**Regra principal:** configurações de **navegador (Edge/Playwright)** e **proxy (Smartproxy)** só mudam com **autorização explícita do Lucas**. Agentes, deploys automáticos e vigias **não** alteram `.env`, proxy ou browser sem ordem direta.

---

## Dois ambientes — nunca misturar

| | Nuvem (Cursor Cloud Agent) | VPS `147.93.13.252` |
|---|---------------------------|---------------------|
| Código | `/workspace/scanner` | `/root/App/scanner` |
| Dados | `XDG_DATA_HOME=/home/ubuntu/.local/share/cloud-bot-home` | `XDG_DATA_HOME=/root/.local/share` |
| `.env` | `…/linkclaro-bot/.env` | `/root/.local/share/linkclaro-bot/.env` |
| Bot Telegram | `@newtesclarbot` | `@Linkclarotesbot` |
| Subir serviços | `bash cloud-start-services.sh` | `bash vps-start-services.sh` |
| tmux | `cloud-automation`, `cloud-telegram-bot`, `cloud-admin` | `vps-automation`, `vps-telegram-bot`, `vps-admin` |

**Proibido sem autorização:**

- Copiar `.env`, fila de cartões ou bancos da nuvem → VPS (ou vice-versa)
- Ligar/desligar proxy em um ambiente ao mexer no outro
- Reiniciar nuvem ao atualizar VPS (e vice-versa)

---

## Padrão oficial — navegador

Estes valores são o **contrato**. Scripts de deploy só podem usar estes defaults; mudança exige autorização.

```env
BROWSER_NAME=edge
BROWSER_USE_PLAYWRIGHT_CHROMIUM=0
HEADLESS=false
RECHARGE_MODE=browser
RECHARGE_BROWSER_FLOW=checkout-link
```

### O que isso significa

- **Edge nativo** via Playwright (`channel: msedge`), modo **InPrivate** (`--inprivate`) — não usa perfil do usuário.
- **`BROWSER_USE_PLAYWRIGHT_CHROMIUM=0`** — não trocar para Chromium bundled sem autorização.
- **`HEADLESS=false`** — checkout com UI real (antifraude). Na VPS usa **Xvfb** (`DISPLAY=:1`); na nuvem `DISPLAY=:1` do pod.

### Instalação (VPS ou máquina nova)

```bash
# Node 22+, deps sistema
apt install -y xvfb tmux microsoft-edge-stable

cd /root/App/scanner   # ou /workspace/scanner na nuvem
npm install --omit=dev
npx playwright install msedge
```

### Flags fixas do Edge (não alterar sem autorização)

Definidas em `automation/browser.mjs`:

- `--disable-quic` — QUIC vaza IP real fora do proxy HTTP
- `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`
- `--disable-blink-features=AutomationControlled`
- Viewport mobile iPhone 12, locale `pt-BR`, timezone `America/Sao_Paulo`

### Sessões Edge

| Variável | Nuvem (padrão) | VPS (padrão) | Notas |
|----------|----------------|--------------|-------|
| `MAX_CONCURRENT_SESSIONS` | `3` | `3` | Máximo de Edges abertos |
| `CLOSE_ALL_SESSIONS_ON_START` | `0` | `1` | VPS: 1 recarga por vez (menos 429/cleanup) |
| `SESSION_MAX_LIFETIME_MS` | `180000` | `180000` | Watchdog fecha Edge travado |
| `KEEP_BROWSER_OPEN_SECONDS` | `0` | `0` | Fecha logo após pagamento |

---

## Padrão oficial — proxy

**Estado padrão em ambos os ambientes: DESLIGADO**

```env
PROXY_ENABLED=0
PROXY_PAYMENT_ONLY=0
PROXY_ROTATE=0
PROXY_LOG_IP=0
```

Credenciais Smartproxy ficam **no `.env` de cada ambiente** (não commitar). Conta de referência aprovada:

- `PROXY_SERVER=proxy.smartproxy.net`
- `PROXY_PORT=3120`
- `PROXY_USERNAME=smart-jr4ws4t0cq04_area-BR` (funciona na nuvem e VPS)
- ~~`smart-lucasfer_area-BR`~~ — **não usar** (falha auth na nuvem)

### Ligar proxy (somente com autorização)

Na máquina alvo:

```bash
export PROXY_SERVER=proxy.smartproxy.net
export PROXY_PORT=3120
export PROXY_USERNAME=smart-jr4ws4t0cq04_area-BR
export PROXY_PASSWORD='…'

# Opção A — só pagamento Eldorado (menos tráfego proxy):
bash scanner/enable-proxy.sh   # define PROXY_ENABLED=1 + PROXY_PAYMENT_ONLY=1

# Opção B — todo tráfego HTTP (link + sessão + checkout):
# editar .env manualmente: PROXY_ENABLED=1 e PROXY_PAYMENT_ONLY=0
```

Reiniciar **só o ambiente alterado**:

```bash
# VPS
bash /root/App/scanner/vps-start-services.sh

# Nuvem
bash /workspace/scanner/cloud-start-services.sh
```

### Desligar proxy (padrão)

```bash
bash scanner/disable-proxy.sh
# depois reiniciar serviços do ambiente
```

Ou manualmente no `.env`: `PROXY_ENABLED=0` e reiniciar.

### Verificar se proxy está ativo

```bash
# Log da automação ao subir:
#   [automation] proxy=OFF          → desligado
#   [automation] proxy=host:port    → ligado

curl -s http://127.0.0.1:3000/health

# Teste de egress (com PROXY_ENABLED=1):
cd scanner && set -a && source "$DATA_DIR/.env" && set +a \
  && node scripts/check-browser-proxy.mjs
```

---

## Deploy VPS (`vps-deploy-fresh.sh`)

Usado **apenas** para recriar VPS do zero (banco limpo, token novo). Regras:

1. **Nunca** rodar na nuvem
2. **Não** sobrescreve proxy para `1` — herda padrão `PROXY_ENABLED=0`
3. **Não** copia dados da nuvem
4. Sincroniza **código** + `.env` template com os defaults deste documento

---

## O que causa 429 (contexto)

Não é “Edge vazando” — o browser fecha certo. O rate limit vem de **muitas chamadas HTTP à API Claro** no mesmo IP:

1. `POST /sessions/` (login)
2. `POST /smartcheckout/v2/url` (checkout)
3. Cleanup pós-recarga (wallet refresh) — **reduzido no código** para não repetir se já tem token

Se 429 persistir **com proxy off**, o IP do datacenter está queimado → só ligar proxy **com autorização** ou aguardar cooldown.

---

## Checklist para agentes / vigias

- [ ] Conferir `/health` e processos — **ok**
- [ ] **Não** alterar `PROXY_ENABLED`, credenciais proxy, `BROWSER_*`, `HEADLESS`
- [ ] **Não** alterar fila, `.env`, bancos, VPS ao vigiar nuvem
- [ ] **Não** reiniciar se já estiver no ar
- [ ] **Não** matar sessão de recarga (`aliveSessions > 0`)

---

## Histórico de decisões

| Data | Decisão |
|------|---------|
| 2026-09-01 | Nuvem: proxy **off**, IP AWS funciona |
| 2026-09-02 | VPS: proxy testado **on** por 429; Lucas pediu **off** — padrão permanente off salvo ordem |
| 2026-09-02 | VPS: `CLOSE_ALL_SESSIONS_ON_START=1` (1 Edge por vez) |
| 2026-09-02 | Código: reutiliza `claroSessionId` + skip wallet refresh duplicado no cleanup |

---

*Última revisão: 2026-09-02. Alterações neste documento ou nos defaults exigem autorização do Lucas.*
