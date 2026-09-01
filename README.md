# standard-api

API REST Multi-Instâncias e Cliente WhatsApp Web Multi-Device de alta performance implementado do zero em Node.js (protocolo binário WABinary + Noise XX + Signal Protocol E2EE + Media Cipher), sem dependências de navegadores (sem Puppeteer/Chromium).

---

## 🚀 Como Iniciar a API REST (Fastify)

Para iniciar o servidor HTTP da API:

```bash
npm start
```
O servidor iniciará em `http://localhost:3000`.

---

## 📖 Documentação Swagger Interativa

Acesse no seu navegador para visualizar e testar todos os endpoints interativamente:

👉 **[http://localhost:3000/docs](http://localhost:3000/docs)**

---

## 📡 Endpoints da API REST

### 1. Criar Nova Instância
Cria uma nova instância isolada para conectar outro número de WhatsApp.
```bash
curl -X POST http://localhost:3000/instance/create \
  -H "Content-Type: application/json" \
  -d '{ "instanceName": "vendas" }'
```

---

### 2. Listar Todas as Instâncias
```bash
curl -X GET http://localhost:3000/instance/list
```

---

### 3. Obter QR Code de uma Instância
Retorna o QR Code ativo para escanear no WhatsApp.
```bash
curl -X GET http://localhost:3000/instance/qr/vendas
```
**Resposta:**
```json
{
  "instanceName": "vendas",
  "status": "qrcode",
  "qr": "2@b3q5...",
  "qrBase64": "data:image/png;base64,iVBORw0KGgoAAA..."
}
```

---

### 4. Enviar Mensagem de Texto
```bash
curl -X POST http://localhost:3000/message/send-text/vendas \
  -H "Content-Type: application/json" \
  -d '{
    "number": "5599991081780",
    "text": "Olá! Mensagem enviada via API REST 🚀"
  }'
```

---

### 5. Enviar Mídias (`POST /message/send-media/:instanceName`)

Suporta **Imagens**, **Áudios/PTT (Gravação de Voz)**, **Documentos/PDFs**, **Vídeos** e **Figurinhas (Stickers)** via URL pública ou Base64:

#### 📸 Envio de Imagem:
```bash
curl -X POST http://localhost:3000/message/send-media/default \
  -H "Content-Type: application/json" \
  -d '{
    "number": "5599991081780",
    "type": "image",
    "media": "https://images.unsplash.com/photo-1579202673506-ca3ce28943ef?w=500",
    "caption": "Foto incrível!"
  }'
```

#### 🎙️ Envio de Áudio / Gravação de Voz (PTT):
```bash
curl -X POST http://localhost:3000/message/send-media/default \
  -H "Content-Type: application/json" \
  -d '{
    "number": "5599991081780",
    "type": "audio",
    "media": "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
    "ptt": true
  }'
```

#### 📄 Envio de Documento / PDF:
```bash
curl -X POST http://localhost:3000/message/send-media/default \
  -H "Content-Type: application/json" \
  -d '{
    "number": "5599991081780",
    "type": "document",
    "media": "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    "fileName": "relatorio-financeiro.pdf"
  }'
```

---

### 6. Configuração de Webhooks em Tempo Real
Receba eventos de novas mensagens recebidas (`messages.upsert`), status da conexão (`connection.update`) e recibos de leitura (`receipts.update`):
```bash
curl -X POST http://localhost:3000/webhook/set/default \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://meu-endpoint.com/webhook",
    "enabled": true,
    "events": ["messages.upsert", "connection.update"],
    "headers": { "Authorization": "Bearer token-secreto" }
  }'
```

---

## 🛠️ Recursos Implementados

- **Arquitetura Multi-Instâncias (Multi-Tenant)**: Dezenas de números conectados simultaneamente em pastas isoladas (`./sessions/<instanceName>`).
- **Envio e Cifragem de Mídias para CDN**: Cifragem AES-256-CBC + HKDF + HMAC com upload seguro para `mms.whatsapp.net`.
- **Criptografia Noise XX**: Handshake direto com os servidores do WhatsApp via WebSocket.
- **Signal Protocol E2EE (Double Ratchet)**: Troca de pré-chaves, padding PKCS7 aleatório e cifragem multi-device.
- **USync Resolver + Cache**: Resolução inteligente de números canônicos (com ou sem 9º dígito).
- **Fastify REST API + Swagger UI**: Servidor HTTP moderno, leve e ultra-rápido com documentação OpenAPI interativa em `/docs`.
