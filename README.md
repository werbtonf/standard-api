# standard-api

Cliente não-oficial do WhatsApp Web implementado do zero em Node.js (protocolo binário WABinary + Noise XX_25519_AESGCM_SHA256), sem dependências pesadas de automação de navegador (Puppeteer/Chromium).

## Recursos

- **Conexão WebSocket Direta**: Conecta diretamente a `wss://web.whatsapp.com/ws/chat`.
- **Criptografia Noise XX**: Implementação completa de handshake, verificação de certificados Ed25519 e enquadramento de transporte AES-GCM.
- **Protocolo WABinary**: Encoder e Decoder de nós binários com dicionários de tokens e suporte a compressão zlib.
- **Pareamento por QR Code Atualizado**: Tratamento completo do fluxo recente do WhatsApp com rotação de `advSecretKey` (`companion_reg_refresh`) e resposta de ACKs universais.
- **Roteamento de Borda**: Suporte automático a `edge_routing` (`?ED=`).
- **Persistência de Sessão**: Armazenamento e restauração de credenciais Signal/Noise.

## Instalação

```bash
npm install
```

## Uso

### Pareamento por QR Code

```bash
node examples/register.js
```

O QR Code será renderizado no terminal e salvo como imagem em `/tmp/wa-api-qr.png`.

## Licença

MIT
