# standard-api

API REST e Cliente WhatsApp Web Multi-Device de alta performance implementado do zero em Node.js (protocolo binário WABinary + Noise XX + Signal Protocol E2EE), sem dependências pesadas de navegador (sem Puppeteer/Chromium).

---

## 🚀 Como Iniciar a API REST (Fastify)

Para iniciar o servidor HTTP da API:

```bash
npm start
```
O servidor iniciará em `http://localhost:3000`.

---

## 📡 Endpoints da API REST

### 1. Status da Conexão
Retorna o estado da conexão e os dados da conta conectada.
```bash
curl -X GET http://localhost:3000/instance/status
```
**Resposta de Exemplo:**
```json
{
  "status": "open",
  "connected": true,
  "me": {
    "id": "556392757009@s.whatsapp.net:52",
    "lid": "225804415979533@lid:52"
  },
  "uptime": 120,
  "timestamp": "2026-09-01T22:22:18.014Z"
}
```

---

### 2. QR Code para Conectar Aparelho
Retorna o QR Code em formato JSON (base64) ou como página HTML para escanear no navegador.
* **No Navegador (Auto-refresh):** `http://localhost:3000/instance/qr?format=html`
* **JSON:**
```bash
curl -X GET http://localhost:3000/instance/qr
```

---

### 3. Enviar Mensagem de Texto
Envia uma mensagem criptografada ponta a ponta (E2EE Signal) para qualquer número.
```bash
curl -X POST http://localhost:3000/message/send-text \
  -H "Content-Type: application/json" \
  -d '{
    "number": "5599991081780",
    "message": "Olá! Mensagem enviada via API REST Fastify 🚀"
  }'
```
**Resposta:**
```json
{
  "status": "SUCCESS",
  "messageId": "1788301341775-4",
  "to": "559991081780@s.whatsapp.net",
  "timestamp": 1788301341
}
```

---

### 4. Gerenciamento de Conexão
* **Iniciar Conexão:** `POST http://localhost:3000/instance/connect`
* **Logout (desconectar e limpar sessão):** `POST http://localhost:3000/instance/logout`

---

## 💻 Uso como Biblioteca Node.js

```javascript
import { connectWA } from 'standard-api';
import { readFile } from 'node:fs/promises';

const creds = JSON.parse(await readFile('./sessions/session.json', 'utf8'));
const client = await connectWA({ creds });

client.ev.on('connection.update', (update) => {
  if (update.connection === 'open') {
    client.sendMessage('5599991081780', { text: 'Olá!' });
  }
});
```

---

## 🛠️ Recursos Implementados

- **Criptografia Noise XX**: Handshake direto com os servidores do WhatsApp via WebSocket.
- **Signal Protocol E2EE (Double Ratchet)**: Troca de pré-chaves, padding PKCS7 aleatório e cifragem multi-device.
- **USync Resolver**: Resolução automática de números canônicos (com ou sem 9º dígito).
- **Fastify REST API**: Servidor HTTP moderno, leve e ultra-rápido.
