# Claro Recarga — Mapa Completo de API e Rotas

> Gerado em 2026-08-26 · Portal: `minhaclaro_web` · MSISDNs teste: `62994908313`, `21978682245`

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
- Tokenização: `https://eldorado.m4u.com.br/tokenizer/validation`
- BIN lookup: `https://eldorado.m4u.com.br/v1/bins/{bin6}`
- Auth: `Authorization: Bearer {token}` + `x-bsc: client` + `x-session-id: {checkout_code}`
- SSE pagamento: `GET /payments/{id}/sse`

### Wallet — cartões salvos (Eldorado)

> Cartões vinculados **não aparecem** em `GET /customers/{msisdn}/payment-methods` (`elements: []`).  
> Ficam na wallet Bemobi, acessível via sessão Smart Checkout.

| Método | Endpoint | Auth | Descrição |
|--------|----------|------|-----------|
| GET | `/api-bsc/api/v1/cards` | Bearer + x-bsc | Lista cartões salvos |
| GET | `/api-bsc/api/v1/cards?all_tokens=true` | Bearer + x-bsc | Lista com todos os tokens |
| DELETE | `/api-bsc/api/v1/cards/{token}` | Bearer + x-bsc | **Remove cartão da wallet** (200) |
| DELETE | `/api-bsc/api/v1/cards/{token}?all_tokens=true` | Bearer + x-bsc | Remove (variante) |

**Response GET `/cards` (exemplo MSISDN 21978682245):**
```json
[{
  "type": "CREDIT",
  "token": "77D50275-****-****-****-************",
  "brand": "VISA",
  "bin": "422061",
  "last": "6593",
  "expirationMonth": 12,
  "expirationYear": 2032,
  "holder": {"name": "", "email": "", "phoneNumber": ""},
  "wasValidated": false
}]
```

**Pagamento com cartão salvo** — mesmo `POST /payments`, usando `card.token` da wallet + **CVV obrigatório**:
```json
{
  "method": "credit",
  "installments": 1,
  "card": {
    "token": "{wallet_token}",
    "expirationYear": 2032,
    "expirationMonth": 12,
    "cvv": "***",
    "brand": "VISA",
    "bin": "422061",
    "last": "6593",
    "holder": {"name": "TITULAR", "email": "", "phoneNumber": ""},
    "paymentWallet": "bemobi",
    "wasSaved": true
  }
}
```

### DELETE cartão — API Claro vs Eldorado

| API | Endpoint | Smart Checkout | Resultado teste |
|-----|----------|----------------|-----------------|
| Claro (legado) | `DELETE /customers/{msisdn}/payment-methods/{type}-{id}` | ❌ | 422 — não remove wallet |
| Eldorado (ativo) | `DELETE /api-bsc/api/v1/cards/{token}` | ✅ | 200 — remove da wallet |

Formato legado Claro (JS `qe()`): `{type}` = `credit`, `{id}` = ID interno (não é o token Eldorado).

### Perfil cliente — diferenças observadas

| Campo | MSISDN 62994908313 | MSISDN 21978682245 |
|-------|-------------------|-------------------|
| status | CREATED | ACTIVATED |
| registerOrigin | MINHA_CLARO_WEB | APP_MINHA_CLARO |
| payment-methods elements | `[]` | `[]` (cartões na wallet Eldorado) |
| traits | planType N/A | plan_offer prezao, plan_offer_status active |
| recharges | `[]` | histórico PIX ok + cartão nok |

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

## 13. Teste com cartão 4111111111111111 (Visa teste)

### API legada (claro-recarga-api) — **deprecada para cartão**

| Endpoint | Status | Resultado |
|----------|--------|-----------|
| `POST /v1/cc` | 404 | Não existe neste host |
| `POST /payment-methods` | 500/422 | Schema incorreto / path legado |
| `POST /recharges` | 422 | Exige token real do gateway |
| `POST /payment` | 400 | Payload inválido |
| `POST /recharges/encrypted` | 422 | Payload criptografado inválido |

**Conclusão:** pagamento com cartão **não passa mais** pela API direta da Claro. Usa Smart Checkout.

### Smart Checkout (Eldorado/Bemobi) — **fluxo ativo (100% mapeado)**

| Passo | Endpoint | Status | Response |
|-------|----------|--------|----------|
| 1 | `POST /smartcheckout/v2/url` | 201 / 429 | URL Eldorado + token (429 após muitas tentativas) |
| 2 | `GET smart-checkout.bemobi.com/api/v1/session?code=` | 201 | Sessão checkout completa + bearer |
| 3 | `GET .../installments?method=credit&currency=BRL&invoice_ids={id}` | 200 | Parcelas (obrigatório antes do pagamento) |
| 4 | `POST eldorado.m4u.com.br/tokenizer/validation` | 201 | `{card_token}` |
| 5 | `GET eldorado.m4u.com.br/v1/bins/{bin6}` | 200 | Brand do cartão |
| 6 | `POST .../api-bsc/api/v1/payments` | 200 | `{id, status:"PENDING"}` |
| 7 | `GET .../payments/{id}/sse` | 200 | Evento final: `success` / `DENIED` / `failure` |

### Tokenização — POST `/tokenizer/validation`

```
URL: https://eldorado.m4u.com.br/tokenizer/validation
Header: x-session-id: {checkout_code da URL Eldorado}
```

**Request:**
```json
{
  "card_number": "418230******2570",
  "cvv": "***",
  "expiration_month": "03",
  "expiration_year": "2030",
  "holder_name": "NOME TITULAR",
  "holder_document": "",
  "partner": "MINHA-CLARO-WEB",
  "payment_type": "credit",
  "perform_zero_auth": false
}
```

**Response (201):**
```json
{ "card_token": "7502A17D-****-****-****-************" }
```

### POST `/api-bsc/api/v1/payments` — payload final validado

```json
{
  "method": "credit",
  "installments": 1,
  "card": {
    "token": "{card_token}",
    "expirationYear": 2030,
    "expirationMonth": 3,
    "cvv": "***",
    "brand": "VISA",
    "bin": "418230",
    "last": "2570",
    "holder": { "name": "NOME", "email": "", "phoneNumber": "" },
    "paymentWallet": "bemobi",
    "length": 16
  }
}
```

Headers: `Authorization: Bearer {bemobi_token}`, `x-bsc: client`, `x-session-id: {checkout_code}`

> **Payload mínimo vs browser:** a chamada acima é suficiente para obter `200 PENDING` via API direta. O frontend Eldorado envia um payload maior (device, userBehaviour, 3DS).

### POST `/payments` — payload completo (browser)

Campos adicionais enviados pelo checkout web que **não** aparecem no payload mínimo:

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `invoices` | `string[]` | UUIDs das faturas da sessão Bemobi |
| `saveCard` | `bool` | Salvar cartão na wallet Eldorado |
| `saveRecurrence` | `bool` | Opt-in recarga recorrente |
| `walletEnabled` | `bool` | Wallet habilitada na sessão |
| `autoSaveCardEnabled` | `bool` | Auto-save após pagamento |
| `autoRecurrenceOptIn` | `bool` | Opt-in automático recorrência |
| `allowMultipleCardOptIn` | `bool` | Múltiplos cartões |
| `paymentWallet` | `string` | `"bemobi"` (nível raiz, além de `card.paymentWallet`) |
| `otherPaymentMethodCollapsed` | `bool` | UI state |
| `paymentMethodsShown` | `object` | Métodos exibidos (`credit`, `pix`, `google_pay`, etc.) |
| `device` | `object` | Fingerprint: `id`, `screenWidth/Height`, `userAgent`, `platform`, `browser`, `deviceType`, `colorDepth`, `language`, `timeZoneOffset`, `cookiesEnabled`, `javaEnabled` |
| `userBehaviour` | `object` | Antifraude: `keystrokeEvents[]`, `formFieldEvents[]`, `formFieldInteractionTime{}`, `mouseEvents[]` |
| `card.threeDSecure` | `object` | Resultado 3DS: `xid`, `eci`, `version`, `referenceId`, `cavv`, `tdsdsxid` |
| `card.wasSaved` | `bool` | Cartão já estava salvo |
| `card.issuer` | `string` | Emissor (BIN lookup) |

Headers extras no browser:
- `X-User-IP: {ip_cliente}`
- `newrelic`, `traceparent`, `tracestate` (APM)
- Cookies Hotjar (`_hjSession_*`)

**Exemplo estrutural (mascarado):**
```json
{
  "method": "credit",
  "installments": 1,
  "invoices": ["bef0b658-****-****-****-************"],
  "saveCard": true,
  "saveRecurrence": false,
  "walletEnabled": true,
  "autoSaveCardEnabled": true,
  "paymentWallet": "bemobi",
  "card": {
    "token": "F25EFA99-****-****-****-************",
    "expirationYear": 2030,
    "expirationMonth": 12,
    "cvv": "***",
    "brand": "VISA",
    "bin": "411111",
    "last": "1111",
    "wasSaved": false,
    "threeDSecure": { "xid": "", "eci": "", "version": "", "referenceId": "", "cavv": "", "tdsdsxid": "" },
    "holder": { "name": "TESTE APROVADO" },
    "paymentWallet": "bemobi"
  },
  "device": { "id": "uuid", "screenWidth": 1951, "screenHeight": 1220, "platform": "linux", "browser": "Chrome", "deviceType": "desktop", "type": "BROWSER" },
  "userBehaviour": {
    "keystrokeEvents_count": 162,
    "formFieldInteractionTime": { "card_number": 24748, "name": 34084, "expiration_date": 24329, "cvv": 36921 }
  }
}
```

### 3D Secure (Braspag + Cardinal Commerce)

Observado no fluxo browser (cartão teste VISA R$20):

| Recurso | URL / script |
|---------|--------------|
| Braspag 3DS | `script-braspag-3ds.js` (CDN Eldorado) |
| Cardinal songbird | `songbird.js` |
| Challenge bind | `/challenge/bind/VISA/methodProd...` |
| Tokenização | `POST /tokenizer/validation` → `card_token` antes do pay |

No teste com `411111******1111`, `card.threeDSecure` foi enviado com campos vazios (sem challenge concluído). Cartões reais provavelmente preenchem `cavv`/`eci` após o fluxo 3DS.

**Response (200):**
```json
{
  "id": "cd16923d-7566-416f-9d21-47af9402e64a",
  "status": "PENDING"
}
```

Erros comuns:
- `holder` deve ser **objeto**, não string
- `installments` deve ser **int**, não objeto
- PAN em `card.number` → `402 Token at index 0 can't be null` — **obrigatório tokenizar antes**
- Sem GET `/installments?method=credit` antes → `400 installment not in session`
- Payload incompleto (sem brand/bin/paymentWallet) → `402 PM:001 invalid request`
- Múltiplas tentativas → `429 too-many-requests`

### GET `/installments?method=credit&currency=BRL&invoice_ids={uuid}`

```json
[{
  "installments": 1,
  "installmentValue": 1500,
  "currencyCode": "BRL",
  "totalValue": 1500,
  "totalFee": 0,
  "totalDiscount": 0,
  "interestRate": 0
}]
```

> Parâmetro `method=credit` + `invoice_ids` é obrigatório (diferente do probe inicial com apenas `value=1500`).

### Bemobi session — métodos permitidos

```json
"paymentMethodsAllowed": ["credit", "pix", "googlepay", "applepay", "clicktopay", "nupay"]
```

Features ativas: 3DS, wallet, click-to-pay, tokenização web.

### Confirmação de pagamento (Eldorado) — testado

```
GET {eldorado}/api-bsc/api/v1/payments/{id}/sse
Headers: Authorization: Bearer {token}, x-bsc: client
Accept: text/event-stream

Events: pix_code | timeout | success | failure | DENIED
```

**Exemplo SSE real (cartão 418230… · R$15 · 2026-08-26):**
```json
{
  "status": "DENIED",
  "negativeReason": "CREDIT_CARD - 422 - suspected fraud",
  "payments": [{
    "method": "CREDIT_CARD",
    "installments": 1,
    "totalAmount": { "currency": "BRL", "value": 1500 },
    "card": { "brand": "VISA", "bin": "418230", "last": "2570" },
    "status": "DENIED"
  }],
  "extra": {
    "postMessage": {
      "type": "ok",
      "status": "DENIED",
      "transaction": {
        "status": "DENIED",
        "reason": "CREDIT_CARD - 422 - suspected fraud"
      }
    }
  }
}
```

### Limitações / rate limits

- `POST /smartcheckout/v2/url` → 429 após muitas tentativas (usar checkout_code existente)
- `POST /payments` → 429 após tentativas rápidas
- Pagamento via API sem browser pode ser negado por antifraude (422 suspected fraud)
- Payload browser inclui `userBehaviour` + `device` — omitir pode aumentar score de fraude
- Fluxo 3DS Braspag/Cardinal carregado no browser; challenge completo não concluído neste teste

### O que ainda não foi exercitado

- POST `/payments` → SSE `success` (cartões negados por antifraude nestes testes)
- Fluxo 3DS challenge completo com `cavv`/`eci` preenchidos (Braspag/Cardinal)
- PIX end-to-end via API direta (`POST /recharges/encrypted`)
- Google Pay / Apple Pay / Click to Pay
- PayPal / Mercado Pago authorize + delete
- Recarga programada (POST/DELETE `/scheduled-recharges`) — retorna `[]` neste número

---

O mapa da API está neste arquivo. Dumps de probe/HAR de teste foram removidos.
