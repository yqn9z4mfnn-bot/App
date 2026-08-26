# Claro Recarga — Mapa Completo de API e Rotas

> Gerado em 2026-08-26 · Portal: `minhaclaro_web` · MSISDN teste: `62994908313`

---

## 1. Autenticação

### Headers obrigatórios (pós-login)

| Header | Valor | Quando |
|--------|-------|--------|
| `authorization` | `claro {session_id}` | Todas as APIs autenticadas |
| `channel` | `MINHA_CLARO_WEB` | Todas as requisições |
| `Content-Type` | `application/json` | POST/PUT |
| `device-id` | fingerprint (string) | POST `/recharges` |

### Login via JWT (`?t=` na URL)

```
POST https://claro-recarga-api.m4u.com.br/sessions/
Header: channel: MINHA_CLARO_WEB
```

**Request:**
```json
{
  "data": "<JWT da URL>",
  "type": "encrypted",
  "channel": ["minhaclaro_web", "MINHA_CLARO_WEB"],
  "origin": "login"
}
```

**Response:**
```json
{
  "id": "a3cddc22-bfb3-4d1c-a342-a6ec5096fb16",
  "partnerExternalId": "d0c6c147-a9f3-43ad-9320-3d5bd18b96e0",
  "identifier": "62994908313",
  "segment": "CLARO_CARTAO"
}
```

- `id` → usado como `authorization: claro {id}`
- `identifier` → MSISDN, salvo em `localStorage.identifier`
- `partnerExternalId` → `sessionStorage.partnerExternalId`

### Login via SMS (alternativo)

```
POST /sms-tokens/     → solicita código SMS
POST /sessions/       → confirma com código (cliente c.f)
GET  /sessions/{identifier}/tmp/token → token temporário
PUT  /sessions/revalidate
POST /sessions/revalidate
```

### Storage (browser)

| Chave | Storage | Conteúdo |
|-------|---------|----------|
| `identifier` | localStorage | MSISDN |
| `segment` | localStorage | ex: `CLARO_CARTAO` |
| `token` | sessionStorage | session UUID |
| `partnerExternalId` | sessionStorage | UUID parceiro |
| `channel` | sessionStorage | `MINHA_CLARO_WEB` |
| `channelPath` | sessionStorage | ex: `minhaclaro_web` |

---

## 2. Backends / Domínios

| Domínio | Função |
|---------|--------|
| `clarorecarga.claro.com.br` | Frontend SPA (CloudFront/S3) |
| `claro-recarga-api.m4u.com.br` | API principal |
| `cc-brand.plat-m4u.io` | BIN lookup cartões (`/v1/brand`) |
| `eldorado.m4u.com.br` | Smart Checkout BSC (`/bsc/checkout`) |
| `eldorado.m4u.com.br/api-bsc/api/v1` | API checkout Eldorado |
| `smart-checkout.bemobi.com` | Checkout iframe (`/api/v1/session`) |
| `smart-checkout-dev.bemobi.com` | Checkout dev (retornado em alguns ambientes) |
| `ponte-pix-claro-recarga.bemobi.com/pix/` | Ponte PIX |
| `ponte-eldorado.frontend-cdn.m4u.com.br` | CDN bridge Eldorado |
| `portal.clarotv.m4u.com.br` | Claro TV |
| `portal.claro-tv.m4u.com.br` | Claro TV agendada |

---

## 3. API — Todos os Endpoints

### Sessão
| Método | Endpoint | Auth | Descrição |
|--------|----------|------|-----------|
| POST | `/sessions/` | channel | Criar sessão |
| GET | `/sessions/{id}/tmp/token` | claro token | Token temporário |
| PUT | `/sessions/revalidate` | claro token | Revalidar sessão |
| POST | `/sessions/revalidate` | claro token | Revalidar sessão |
| POST | `/sms-tokens/` | — | Enviar SMS OTP |

### Cliente
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/customers/{msisdn}` | Dados do cliente |
| POST | `/customers/` | Criar cliente |
| PUT | `/customers/{msisdn}` | Atualizar |
| DELETE | `/customers/{msisdn}` | Remover |
| GET | `/customers/{msisdn}/products` | Valores de recarga |
| GET | `/customers/{msisdn}/payment-methods` | Métodos de pagamento |
| GET | `/customers/{msisdn}/recharges` | Histórico recargas |
| GET | `/customers/{msisdn}/recharges` + `reloadType: recurring` | Recargas recorrentes |
| GET | `/customers/{msisdn}/recharge/balance` | Saldo (404 neste número) |
| GET | `/customers/{msisdn}/recipients` | Destinatários |
| POST | `/customers/{msisdn}/recipients/{msisdn}` | Add destinatário |
| PUT | `/customers/{msisdn}/recipients/{msisdn}` | Atualizar destinatário |
| DELETE | `/customers/{msisdn}/recipients/{msisdn}` | Remover destinatário |
| GET | `/customers/{msisdn}/scheduled-recharges` | Recargas programadas |
| POST | `/customers/{msisdn}/scheduled-recharges` | Criar programada |
| DELETE | `/customers/{msisdn}/scheduled-recharges/{id}` | Cancelar programada |
| POST | `/customers/{msisdn}/recharges` | **Efetivar recarga** (+ header `device-id`) |
| POST | `/customers/{msisdn}/payment` | Pagamento (TV/legado) |
| POST | `/customers/{msisdn}/payment-methods` | Salvar cartão |
| DELETE | `/customers/{msisdn}/payment-methods/{type}-{id}` | Remover cartão |
| POST | `/customers/{msisdn}/payment-methods/paypal/authorize` | Auth PayPal |
| POST | `/customers/{msisdn}/payment-methods/paypal/accounts` | Conta PayPal |
| DELETE | `/customers/{msisdn}/payment-methods/paypal/accounts/{id}` | Remover PayPal |
| POST | `/customers/{msisdn}/smartcheckout/v2/url` | URL checkout smart |
| POST | `/customers/{msisdn}/smartcheckout/recurrence/url` | URL recorrência |
| POST | `/customers/{msisdn}/loop/events` | Analytics interno |

### Eventos / misc
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/customer/{msisdn}/events/checkout` | Evento início checkout |
| POST | `/recharges/encrypted` | Recarga criptografada (PIX) |
| GET | `/recharges/result/{id}` | Resultado recarga |
| GET | `/recharges/recurrence/result/{id}` | Resultado recorrência |
| GET | `/banners` | Banners promocionais |
| PUT | `/govisa/{msisdn}` | Promo Visa |
| GET | `/govisa/{msisdn}/activated` | Status promo Visa |
| POST | `/v1/cc` | Validar PAN cartão |
| GET | `/v1/brand` | BIN brands (host: cc-brand.plat-m4u.io) |
| GET | `/v1/features/public` | Features públicas |
| GET | `/v1/features/{name}/enabled` | Feature flag |
| GET | `/v1/features/group/{group}/enabled` | Feature group |

---

## 4. Feature Flags (capturadas)

| Flag | Valor |
|------|-------|
| `maintenance` | `false` |
| `loginWithValue` | `true` |
| `environmentCheckout` | `production` |
| `fraud_analysis` | `false` |
| `smartcheckout` | `{smartcheckout:true, sdkActive:false, wallets:true}` |
| `OTPModal` | `true` |
| `upsell_recharge` | `true` |
| `recharge_for_others` | `true` |
| `value_page_without_banner` | `true` |
| `value_page_without_bonus` | `false` |
| `channel_without_footer` | `false` |
| `value_card_with_no_expiration_date` | `false` |
| `url_without_channel` | `true` |

---

## 5. Fluxo de Pagamento — Cartão de Crédito

```
1. POST /sessions/                    → auth token
2. GET  /customers/{id}/products      → escolher valor
3. GET  /customers/{id}/payment-methods → confirmar "credit" disponível
4. POST /customer/{id}/events/checkout → {customer:{id, credit_cards:[]}}
5. [Smart Checkout path]
   POST /customers/{id}/smartcheckout/v2/url
   Body: {msisdn, channel, recipient, productId}
   → {token, url: "https://eldorado.m4u.com.br/bsc/checkout/?code=..."}
6. GET smart-checkout.bemobi.com/api/v1/session → sessão checkout
7. [Eldorado BSC] pagamento via iframe
   Auth: Bearer {bepay-user-token}
   Header: x-bsc: client
   SSE: GET /payments/{id}/sse → status pagamento
8. [Legacy path]
   POST /v1/cc                         → validar PAN {pan, month, year, partner:"CLARO"}
   POST /customers/{id}/payment-methods → salvar cartão
   POST /customers/{id}/recharges        → efetivar (+ device-id fingerprint)
```

### POST `/recharges` — payload (legado)

```json
{
  "targetMsisdn": "62994908313",
  "rechargeValue": { "id": "uuid", "value": 1500 },
  "paymentMethod": {
    "type": "credit",
    "data": { "token": "card_token", "cvv": "123", "brandName": "VISA", "lastDigits": "1234" }
  },
  "tags": { "value": "15.00", "currency": "BRL", "payment_method": "CREDIT_CARD" }
}
```

Header extra: `device-id: {fingerprint}`

### POST `/v1/cc` — validação cartão

```
Content-Type: application/x-www-form-urlencoded
pan={numero}&month={MM}&year={YY}&partner=CLARO
```

---

## 6. Fluxo PIX

```
1. Selecionar PIX como paymentMethod
2. POST /recharges/encrypted  → {payload: encrypted_data}
3. Response: {id, qrCode, transactionId, expiration}
4. Redirect: ponte-pix-claro-recarga.bemobi.com/pix/
5. Rota frontend: /:channel/pix
6. Confirmação: /:channel/confirmacao-pix
```

---

## 7. Smart Checkout (Eldorado/Bemobi)

### POST smartcheckout/v2/url
```json
// Request
{"msisdn":"62994908313","channel":"MINHA_CLARO_WEB","recipient":"62994908313","productId":"03868918-975d-4e8a-a3ab-d551db9f29ea"}

// Response
{"token":"...","url":"https://eldorado.m4u.com.br/bsc/checkout/?code=...","paymentItemsId":["..."],"allowRecurrenceOptin":false}
```

### GET smart-checkout.bemobi.com/api/v1/session
Retorna sessão completa com:
- `paymentMethodsAllowed`: credit, pix, googlepay, applepay, clicktopay, nupay
- `invoices[].value`: 1500 (centavos)
- `metadata.features`: 3DS, wallet, multi-payment config

### Eldorado BSC API
- Base: `https://eldorado.m4u.com.br/api-bsc/api/v1`
- Auth: `Authorization: Bearer {token}` + `x-bsc: client`
- SSE pagamento: `GET /payments/{id}/sse`

---

## 8. Tipos de Pagamento

| Constante JS | API type | Label |
|--------------|----------|-------|
| CREDITO | `credit` | Cartão de Crédito |
| PIX | `pix` | Pix |
| DEBITO | `debit` | Débito |
| DEBITO_CEF | `debit_cef` | Débito Virtual Caixa |
| PAYPAL | `paypal` | PayPal |
| MERCADO_PAGO | `mercado_pago` | Mercado Pago |
| GOOGLE_PAY | `google_pay` | Google Pay |

---

## 9. Rotas Frontend (React Router)

Padrão: `https://clarorecarga.claro.com.br/{channel}/{rota}`

| Rota | Função |
|------|--------|
| `/:channel/*login` | Login (select-login, etc.) |
| `/:channel/home` | Home |
| `/:channel/selecionar-valor` | Escolher valor |
| `/:channel/valores-mobile` | Valores mobile |
| `/:channel/pagamento-cartao` | Pagamento cartão |
| `/:channel/pagamento-credito` | Pagamento crédito |
| `/:channel/pagamento-cvv` | CVV |
| `/:channel/pagamento-pix` | — |
| `/:channel/pix` | Fluxo PIX |
| `/:channel/pagamento-googlepay` | Google Pay |
| `/:channel/pagamento-paypal` | PayPal |
| `/:channel/pagamento-mercadopago` | Mercado Pago |
| `/:channel/pagamento-debitocef` | Débito Caixa |
| `/:channel/pagamento-parcelamento` | Parcelamento |
| `/:channel/pagamento-sucesso` | Sucesso |
| `/:channel/pagamento-erro` | Erro |
| `/:channel/confirmacao` | Confirmação |
| `/:channel/confirmacao-pix` | Confirmação PIX |
| `/:channel/confirmacao-beneficio` | Confirmação bônus |
| `/:channel/smartcheckout` | Smart checkout |
| `/:channel/saldo` | Saldo |
| `/:channel/historico` | Histórico |
| `/:channel/minhas-recargas` | Minhas recargas |
| `/:channel/meus-dados` | Meus dados |
| `/:channel/criar-cartao` | Criar cartão |
| `/:channel/novo-credito` | Novo crédito |
| `/:channel/gerenciar-programadas` | Recargas programadas |
| `/:channel/logout` | Logout |
| `/:channel/maintenance` | Manutenção |
| `/:channel/landing` | Landing |
| `/:channel/(tv)/*` | Claro TV |

### Mapeamento de canais

| Path | Channel header |
|------|----------------|
| `minhaclaro_web` | `MINHA_CLARO_WEB` |
| `recarga` | `CLARO_WEB_DESKTOP` |
| `claro-vip` | `CLARO_VIP_WEB` |
| `whatsapp` | `CLARO_WHATSAPP` |
| `tv` | `CLARO_TV_WEB_DESKTOP` |

---

## 10. Produtos / Valores (62994908313)

| Valor | Centavos | Validade | Disponível |
|-------|----------|----------|------------|
| R$ 15 | 1500 | 30 dias | ✅ |
| R$ 20 | 2000 | 30 dias | ✅ |
| R$ 25 | 2500 | 30 dias | ✅ |
| R$ 30 | 3000 | 60 dias | ✅ |
| R$ 35 | 3500 | 90 dias | ✅ |
| R$ 40 | 4000 | 90 dias | ❌ |
| R$ 50 | 5000 | 120 dias | ❌ |
| R$ 100 | 10000 | 180 dias | ❌ |

- Categoria: `FIRST_RELOAD` (cliente `status: CREATED`)
- Limite diário restante: R$ 35,00 (`remaining_spending_limit: 3500`)
- Métodos: credit ✅, pix ✅

---

## 11. Códigos de Erro

| Código | Mensagem |
|--------|----------|
| JA0002 | Aguardar para nova recarga |
| JA0009 | Limite tentativas recarga |
| JA0013 | Limite recebimento diário destinatário |
| JA0014 | Limite gasto diário cliente |
| JA0017 | Limite tentativas destinatário |
| LI0003 | Cartão não relacionado ao cliente |
| LI0004 | Destinatário não relacionado |
| LI0008 | Nenhum produto encontrado |
| LI0012 | Recarga duplicada |
| LI0029 | Fonte pagamento não relacionada |
| LI0032 | Token inválido |
| LI1011 | Tipo pagamento não permitido |
| LI1015 | Falha gateway pagamento |
| SNARF0035 | Limite máximo cartões |
| SNARF0036 | Máximo cartões associados |
| SNARF0038 | Blacklist |
| SNARF0039 | Limite destinatários |
| SNARF0043 | Limite inserções cartão |
| WKIT0027 | Cliente não encontrado |
| MA0001 | Erro ao solicitar recarga |

---

## 12. Analytics / Eventos

### POST `/customers/{id}/loop/events`
```json
{
  "type": "pageview",
  "msisdn": "62994908313",
  "session_id": "uuid",
  "tags": {
    "channel": "web",
    "portal": "minha_claro_web",
    "realm": "claro_recarga",
    "utm_source": "frontend_claro_recarga",
    "utm_term": "adesao",
    "page_name": "home_page"
  }
}
```

### Terceiros (page load)
- GTM: `GTM-TFXKRT2`
- Hotjar: `1335869`
- New Relic: key `8241ce31b6`
- OneTrust cookies
- Google Analytics: `UA-28840052-11`

---

## 13. O que NÃO foi exercitado (requer cartão real)

- POST `/customers/{id}/recharges` com pagamento real
- POST `/v1/cc` com PAN real
- POST `/recharges/encrypted` fluxo PIX completo
- PayPal / Google Pay / Mercado Pago authorize
- Confirmação SSE pagamento Eldorado até `success`

---

## Artefatos

- `/tmp/claro-analysis/full-capture.json` — 48+ requests com headers/bodies
- `/tmp/claro-analysis/api-probe.json` — probe de todos endpoints GET
- `/tmp/claro-analysis/endpoints-parsed.json` — endpoints únicos parseados
