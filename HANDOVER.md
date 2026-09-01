# stdwpp — Handover / Contexto do Projeto

> **Status:** **PAREAMENTO E AUTENTICAÇÃO TOTALMENTE FUNCIONAIS E VALIDADOS!**
> O fluxo de pareamento por QR Code, validação de assinaturas de dispositivo/conta (ADV/Signal), armazenamento de sessão e reconexão autenticada (`<success>`) estão **100% operacionais** contra os servidores oficiais do WhatsApp.

---

## 1. O que é o projeto

Cliente **não-oficial** do WhatsApp Web, implementado **do zero** (sem usar Baileys/WPPConnect), via WebSocket. Objetivo final: uma API consumível por outros projetos (envio/recebimento de mensagens, etc.), funcionando como o Baileys.

- Linguagem: **Node.js** (ESM, `"type": "module"`), Node v22.
- Única dependência runtime: `ws` (WebSocket). Criptografia usa apenas APIs nativas do Node (`crypto`) + `curve25519-js` (Ed25519, mesma lib usada pelo libsignal).
- Pasta: `/home/werbton/stdwpp`

### Estrutura

```
src/
  index.js        # exports públicos: connectWA, decodeBinaryNode, encodeBinaryNode, makeNoiseHandler
  client.js       # orquestrador: conexão, handshake, keepalive, QR pairing, eventos (EventEmitter)
  ws.js           # wrapper WebSocket (ws) com enquadramento de frames + keepalive WS-level
  noise.js        # Noise XX_25519_AESGCM_SHA256 (do zero)
  crypto.js       # sha256, hmac, HKDF, AES-256-GCM, X25519, Ed25519, randomBytes
  proto.js        # encode/decode de protobuf manual (HandshakeMessage, ClientPayload, CertChain, UserAgent, WebInfo, DeviceProps, ADVSignedDeviceIdentity...)
  auth.js         # initAuthCreds, signPreKeys, normalizeCreds, buildRegistrationPayload, buildLoginPayload, buildPairingQRData
  pairing.js      # configureSuccessfulPairing (validação de assinaturas ADV pós-scan)
  wabinary.js     # encoder/decoder binário do protocolo (WABinary) — completo, round-trip validado
  tokens.json     # tabelas SINGLE_BYTE_TOKENS / DOUBLE_BYTE_TOKENS / TAGS (extraídas do Baileys)
  constants.js    # URLs, NOISE_MODE, NOISE_WA_HEADER, WA_CERT_DETAILS, timeouts
examples/
  register.js        # fluxo de registro por QR (gera /tmp/wa-api-qr.png + salva sessão em /tmp/wa-api-session.json)
  test-handshake.js  # testa handshake Noise isolado contra o servidor real
  debug-register.js  # debug do registro com dump de frames
```

---

## 2. O que JÁ FUNCIONA (validado contra servidor real)

1. **WebSocket** em `wss://web.whatsapp.com/ws/chat` com `Origin: https://web.whatsapp.com` e suporte a roteamento de borda (`?ED=`).
2. **Handshake Noise XX_25519_AESGCM_SHA256** completo:
   - `clientHello` → `serverHello` → validação da cadeia de certificados Ed25519 → `clientFinish` → `finishInit`.
3. **Encoder/decoder binário (WABinary)**: decodificação e codificação completas (inclusive com descompressão zlib compatível com ESM).
4. **Registro e Pareamento por QR Code (100% Funcional)**:
   - Servidor envia `<iq type="set"><pair-device><ref>...</ref></pair-device></iq>`.
   - Cliente responde com `<iq type="result"/>`, inicia o temporizador de refs e exibe o QR Code.
   - Suporte ao novo fluxo de notificações do WhatsApp com ACK universal (`buildAckStanza`) e tratamento de `companion_reg_refresh` com rotação de `advSecretKey`.
   - Scan no celular processado com sucesso.
5. **Validação Criptográfica Pós-Scan (`pair-success`)**:
   - Validação da assinatura HMAC com `advSecretKey`.
   - Verificação das assinaturas da identidade da conta com Ed25519 via `curve25519-js`.
   - Geração e envio do `pair-device-sign` com a chave do dispositivo assinado.
6. **Persistência de Sessão e Reconexão Autenticada**:
   - Credenciais salvas em JSON e normalizadas corretamente via `normalizeCreds`.
   - Reconexão enviando `buildLoginPayload` com `passive: true` e `pull: true`.
   - Servidor responde com nó `<success>` e emite o evento `connection.update: { connection: "open" }`.
7. **Criptografia Signal E2EE (Envio e Recebimento)**:
   - Gerenciamento de sessões Double Ratchet via `libsignal`.
   - Busca automática de pré-chaves (`<iq type="get" xmlns="encrypt"><key><user jid="..."/></key></iq>`).
   - Cifragem (`<enc v="2" type="msg/pkmsg">`) e envio de mensagens via `client.sendMessage(jid, { text })`.
   - Decifragem de mensagens recebidas, dispatch no evento `messages.upsert` e envio automático de recibos `<receipt>`.
8. **Keepalive**: `<iq type="get" xmlns="w:p"><ping/></iq>` + pings em nível de WebSocket para estabilidade permanente da conexão.

---

## 3. Correções Aplicadas que Destravaram o Pareamento

1. **ACK Universal para Notificações do Servidor:** Adicionado `buildAckStanza` respondendo imediatamente a todas as notificações enviadas pelo WhatsApp durante o handshake/scan.
2. **Tratamento e Rotação do `companion_reg_refresh`:** Rotação do `advSecretKey` (32 bytes CSPRNG) e re-renderização do mesmo ref quando o servidor solicita refresh de registro.
3. **Roteamento de Borda (`edge_routing` / `?ED=`):** Captura de `<ib><edge_routing><routing_info>` e injeção do parâmetro `?ED=<base64url>` na URL do WebSocket.
4. **Desserialização Segura de Buffers (`normalizeCreds`):** Converte objetos desserializados de JSON de volta para instâncias nativas de `Buffer` antes de operações criptográficas.
5. **Isolamento de Listeners de Frame:** O parser binário do WABinary só é conectado após a conclusão do `noise.finishInit()`, evitando conflitos com o frame do `serverHello`.
6. **Import ESM de Zlib:** Substituição de `require('node:zlib')` por `import { inflateSync } from 'node:zlib'`.

---

## 4. Como Rodar e Testar

```bash
cd /home/werbton/stdwpp
npm install

# Teste de registro e pareamento por QR Code:
rm -f /tmp/wa-api-session.json
node examples/register.js

# Uma vez pareado, executar novamente reutiliza a sessão salva em /tmp/wa-api-session.json:
node examples/register.js
```

---

## 5. Próximos Passos do Projeto

1. **Camada de Envio e Recebimento de Mensagens:**
   - Montagem de nós `<message>` e decodificação de mensagens recebidas (`messages.upsert`).
2. **Criptografia E2E (Signal Protocol):**
   - Integração com o armazenamento de chaves de sessão Signal / Pré-chaves para criptografia e decriptografia fim-a-fim de mensagens de texto, mídias e reações.
3. **Histórico e Sincronização Inicial (App State / History Sync):**
   - Processamento de nós de sincronização inicial (`<ib action="sync">`, chats, contatos).
4. **API de Alto Nível:**
   - Expor métodos convenientes (`sendMessage`, `sendText`, `sendMedia`, `presenceSubscribe`, etc.) como no Baileys.

---

## 6. Referências Úteis

- Baileys (referência de protocolo e tipos): https://github.com/WhiskeySockets/Baileys
- Protocolo binário e tokens: veja `src/wabinary.js` e `src/tokens.json`.
- Criptografia Noise: veja `src/noise.js` e `src/crypto.js`.
- Validação ADV: veja `src/pairing.js`.

