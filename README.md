# standard-api

API REST Multi-Instâncias e Cliente WhatsApp Web Multi-Device de alta performance implementado do zero em Node.js (protocolo binário WABinary + Noise XX + Signal Protocol E2EE), sem dependências de navegadores (sem Puppeteer/Chromium).

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

## 📡 Endpoints da API REST (Multi-Instâncias)

### 1. Criar Nova Instância
Cria uma nova instância isolada para conectar outro número de WhatsApp.
```bash
curl -X POST http://localhost:3000/instance/create \
  -H "Content-Type: application/json" \
  -d '{ "instanceName": "atendimento-01" }'
```

---

### 2. Listar Todas as Instâncias
Retorna todas as instâncias cadastradas, seus status e números conectados.
```bash
curl -X GET http://localhost:3000/instance/list
```
**Resposta de Exemplo:**
```json
[
  {
    "instanceName": "default",
    "status": "open",
    "connected": true,
    "me": {
      "id": "556392757009@s.whatsapp.net:52",
      "lid": "225804415979533@lid:52"
    },
    "uptime": 120,
    "timestamp": "2026-09-01T22:43:07.034Z"
  }
]
```

---

### 3. Obter QR Code de uma Instância
Retorna o QR Code ativo para escanear no WhatsApp.
```bash
curl -X GET http://localhost:3000/instance/qr/atendimento-01
```
**Resposta:**
```json
{
  "instanceName": "atendimento-01",
  "status": "qrcode",
  "qr": "2@b3q5...",
  "qrBase64": "data:image/png;base64,iVBORw0KGgoAAA..."
}
```

---

### 4. Status de uma Instância
```bash
curl -X GET http://localhost:3000/instance/status/atendimento-01
```

---

### 5. Enviar Mensagem de Texto por Instância
Envia uma mensagem criptografada ponta a ponta (E2EE Signal) a partir da instância especificada.
```bash
curl -X POST http://localhost:3000/message/send-text/atendimento-01 \
  -H "Content-Type: application/json" \
  -d '{
    "number": "5599991081780",
    "text": "Olá! Mensagem enviada pelo atendimento 🚀"
  }'
```
**Resposta:**
```json
{
  "status": "SUCCESS",
  "instanceName": "atendimento-01",
  "messageId": "1788302602737-3",
  "to": "559991081780@s.whatsapp.net",
  "timestamp": 1788302602
}
```

---

### 6. Gerenciamento de Instâncias
* **Conectar/Reconectar:** `POST http://localhost:3000/instance/connect/:instanceName`
* **Logout (desconectar):** `POST http://localhost:3000/instance/logout/:instanceName`
* **Deletar Instância:** `DELETE http://localhost:3000/instance/delete/:instanceName`

---

## 🛠️ Recursos Implementados

- **Arquitetura Multi-Instâncias (Multi-Tenant)**: Gerencie dezenas de números conectados simultaneamente em pastas isoladas (`./sessions/<instanceName>`).
- **Criptografia Noise XX**: Handshake direto com os servidores do WhatsApp via WebSocket.
- **Signal Protocol E2EE (Double Ratchet)**: Troca de pré-chaves, padding PKCS7 aleatório e cifragem multi-device.
- **USync Resolver + Cache**: Resolução inteligente de números canônicos (com ou sem 9º dígito).
- **Fastify REST API + Swagger UI**: Servidor HTTP moderno, leve e ultra-rápido com documentação OpenAPI interativa em `/docs`.
