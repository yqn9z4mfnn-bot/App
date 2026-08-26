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
