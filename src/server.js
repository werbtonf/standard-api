import Fastify from 'fastify';
import cors from '@fastify/cors';
import { WhatsAppInstance } from './instance.js';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname'
      }
    }
  }
});

await fastify.register(cors, {
  origin: '*'
});

// Instância principal do WhatsApp
const instance = new WhatsAppInstance({
  sessionDir: process.env.SESSION_DIR || './sessions'
});

// Rota inicial / Info
fastify.get('/', async () => {
  return {
    name: 'standard-api',
    version: '1.0.0',
    description: 'WhatsApp Web Multi-Device REST API (Noise XX + Signal E2EE)',
    endpoints: {
      status: 'GET /instance/status',
      qr: 'GET /instance/qr',
      sendText: 'POST /message/send-text',
      connect: 'POST /instance/connect',
      logout: 'POST /instance/logout'
    }
  };
});

// 1. Status da Instância
fastify.get('/instance/status', async () => {
  return instance.getStatus();
});

// 2. QR Code da Instância
fastify.get('/instance/qr', async (request, reply) => {
  const data = instance.getQR();
  const format = request.query.format;

  if (format === 'html') {
    reply.type('text/html');
    if (data.status === 'open') {
      return `
        <!DOCTYPE html>
        <html>
        <head><title>standard-api - Conectado</title><meta charset="utf-8"></head>
        <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background: #0b141a; color: white;">
          <h1 style="color: #00a884;">🟢 WhatsApp Conectado!</h1>
          <p>Número: <b>${instance.creds?.me?.id || 'Autenticado'}</b></p>
        </body>
        </html>
      `;
    }
    if (!data.qrBase64) {
      return `
        <!DOCTYPE html>
        <html>
        <head><title>standard-api - QR Code</title><meta charset="utf-8"><meta http-equiv="refresh" content="2"></head>
        <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background: #0b141a; color: white;">
          <h2>Aguardando geração do QR Code...</h2>
          <p>Atualizando a cada 2 segundos...</p>
        </body>
        </html>
      `;
    }
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>standard-api - Escanear QR Code</title>
        <meta charset="utf-8">
        <meta http-equiv="refresh" content="15">
      </head>
      <body style="font-family: sans-serif; text-align: center; padding-top: 40px; background: #0b141a; color: white;">
        <h1 style="color: #00a884;">standard-api</h1>
        <p>Abra o WhatsApp no seu celular &gt; Aparelhos conectados &gt; Conectar aparelho</p>
        <div style="background: white; display: inline-block; padding: 15px; border-radius: 12px; margin-top: 10px;">
          <img src="${data.qrBase64}" style="display: block; width: 320px; height: 320px;" alt="QR Code" />
        </div>
        <p style="color: #8696a0; font-size: 14px; margin-top: 20px;">O QR Code atualiza automaticamente.</p>
      </body>
      </html>
    `;
  }

  return data;
});

// 3. Conectar / Iniciar
fastify.post('/instance/connect', async () => {
  if (instance.status === 'open') {
    return { status: 'ALREADY_CONNECTED', message: 'Instância já está conectada.' };
  }
  await instance.init();
  return { status: 'CONNECTING', message: 'Processo de conexão iniciado.' };
});

// 4. Desconectar / Logout
fastify.post('/instance/logout', async () => {
  await instance.logout();
  return { status: 'LOGGED_OUT', message: 'Sessão encerrada com sucesso.' };
});

// 5. Enviar Mensagem de Texto
fastify.post('/message/send-text', {
  schema: {
    body: {
      type: 'object',
      required: ['number'],
      properties: {
        number: { type: 'string' },
        message: { type: 'string' },
        text: { type: 'string' }
      }
    }
  }
}, async (request, reply) => {
  const { number, message, text } = request.body;
  const msgContent = message || text;

  if (!msgContent || typeof msgContent !== 'string' || !msgContent.trim()) {
    reply.status(400);
    return { error: 'O campo "message" ou "text" é obrigatório e não pode ser vazio.' };
  }

  try {
    const result = await instance.sendMessage(number, msgContent);
    return {
      status: 'SUCCESS',
      messageId: result.key?.id,
      to: result.key?.remoteJid,
      timestamp: result.messageTimestamp
    };
  } catch (err) {
    reply.status(500);
    return {
      status: 'ERROR',
      error: err.message
    };
  }
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

try {
  // Inicia a instância do WhatsApp automaticamente
  await instance.init();

  // Inicia o servidor HTTP
  await fastify.listen({ port: PORT, host: HOST });
  console.log(`
🚀 standard-api REST rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`   - Status: GET  http://localhost:${PORT}/instance/status`);
  console.log(`   - QR Code: GET http://localhost:${PORT}/instance/qr?format=html`);
  console.log(`   - Envio:  POST http://localhost:${PORT}/message/send-text
`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
