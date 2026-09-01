import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
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
  },
  ajv: {
    customOptions: {
      strict: false
    }
  }
});

await fastify.register(cors, {
  origin: '*'
});

// Configuração do Swagger OpenAPI
await fastify.register(swagger, {
  openapi: {
    info: {
      title: 'standard-api - WhatsApp REST API',
      description: 'API REST de alta performance para WhatsApp Web Multi-Device implementada em Node.js com criptografia Noise XX e Signal Protocol E2EE.',
      version: '1.0.0'
    },
    tags: [
      { name: 'Instance', description: 'Gerenciamento de conexão, sessão e QR Code' },
      { name: 'Messages', description: 'Envio e gerenciamento de mensagens' }
    ]
  }
});

await fastify.register(swaggerUi, {
  routePrefix: '/docs',
  uiConfig: {
    docExpansion: 'list',
    deepLinking: false
  },
  staticCSP: true,
  transformStaticCSP: (header) => header
});

// Instância principal do WhatsApp
const instance = new WhatsAppInstance({
  sessionDir: process.env.SESSION_DIR || './sessions'
});

// Rota inicial / Info
fastify.get('/', {
  schema: {
    hide: true
  }
}, async () => {
  return {
    name: 'standard-api',
    version: '1.0.0',
    description: 'WhatsApp Web Multi-Device REST API (Noise XX + Signal E2EE)',
    documentation: '/docs',
    endpoints: {
      docs: 'GET /docs',
      status: 'GET /instance/status',
      qr: 'GET /instance/qr',
      sendText: 'POST /message/send-text',
      connect: 'POST /instance/connect',
      logout: 'POST /instance/logout'
    }
  };
});

// 1. Status da Instância
fastify.get('/instance/status', {
  schema: {
    tags: ['Instance'],
    summary: 'Status da Conexão',
    description: 'Retorna o estado atual da conexão do WhatsApp e informações do número conectado.',
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'open, connecting, qrcode, close ou disconnected' },
          connected: { type: 'boolean' },
          me: {
            type: 'object',
            nullable: true,
            properties: {
              id: { type: 'string' },
              lid: { type: 'string' }
            }
          },
          uptime: { type: 'number', description: 'Tempo em segundos desde a inicialização' },
          timestamp: { type: 'string', format: 'date-time' }
        }
      }
    }
  }
}, async () => {
  return instance.getStatus();
});

// 2. QR Code da Instância
fastify.get('/instance/qr', {
  schema: {
    tags: ['Instance'],
    summary: 'Obter QR Code',
    description: 'Retorna o QR Code em formato JSON (base64) ou página HTML (adicione ?format=html para escanear no navegador).',
    querystring: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['json', 'html'], default: 'json' }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          qr: { type: 'string', nullable: true },
          qrBase64: { type: 'string', nullable: true }
        }
      }
    }
  }
}, async (request, reply) => {
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
          <p><a href="/docs" style="color: #53bdeb;">Acessar Documentação Swagger (/docs)</a></p>
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
        <p style="color: #8696a0; font-size: 14px; margin-top: 20px;">O QR Code atualiza automaticamente a cada 15 segundos.</p>
      </body>
      </html>
    `;
  }

  return data;
});

// 3. Conectar / Iniciar
fastify.post('/instance/connect', {
  schema: {
    tags: ['Instance'],
    summary: 'Iniciar Conexão',
    description: 'Inicia o processo de conexão do WhatsApp ou gera um novo QR Code caso desconectado.',
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          message: { type: 'string' }
        }
      }
    }
  }
}, async () => {
  if (instance.status === 'open') {
    return { status: 'ALREADY_CONNECTED', message: 'Instância já está conectada.' };
  }
  await instance.init();
  return { status: 'CONNECTING', message: 'Processo de conexão iniciado.' };
});

// 4. Desconectar / Logout
fastify.post('/instance/logout', {
  schema: {
    tags: ['Instance'],
    summary: 'Desconectar / Logout',
    description: 'Encerra a conexão ativa e remove as credenciais da sessão.',
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          message: { type: 'string' }
        }
      }
    }
  }
}, async () => {
  await instance.logout();
  return { status: 'LOGGED_OUT', message: 'Sessão encerrada com sucesso.' };
});

// 5. Enviar Mensagem de Texto
fastify.post('/message/send-text', {
  schema: {
    tags: ['Messages'],
    summary: 'Enviar Mensagem de Texto',
    description: 'Envia uma mensagem de texto cifrada com Signal Protocol E2EE para o número especificado.',
    body: {
      type: 'object',
      required: ['number', 'text'],
      properties: {
        number: {
          type: 'string',
          description: 'Número do destinatário com DDD (com ou sem DDI 55). Ex: "99991081780" ou "559991081780"'
        },
        text: {
          type: 'string',
          description: 'Texto da mensagem a ser enviada'
        }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          messageId: { type: 'string' },
          to: { type: 'string' },
          timestamp: { type: 'number' }
        }
      },
      400: {
        type: 'object',
        properties: {
          error: { type: 'string' }
        }
      },
      500: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          error: { type: 'string' }
        }
      }
    }
  }
}, async (request, reply) => {
  const { number, text, message } = request.body;
  const msgContent = text || message;

  if (!msgContent || typeof msgContent !== 'string' || !msgContent.trim()) {
    reply.status(400);
    return { error: 'O campo "text" é obrigatório e não pode ser vazio.' };
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
  await instance.init();
  await fastify.listen({ port: PORT, host: HOST });
  console.log(`
🚀 standard-api REST rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`   - 📖 Swagger Docs:  http://localhost:${PORT}/docs`);
  console.log(`   - 🔍 Status:        GET  http://localhost:${PORT}/instance/status`);
  console.log(`   - 📱 QR Code HTML:  GET  http://localhost:${PORT}/instance/qr?format=html`);
  console.log(`   - 💬 Envio Texto:   POST http://localhost:${PORT}/message/send-text
`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
