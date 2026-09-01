import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { InstanceManager } from './instance.js';

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
      title: 'standard-api - WhatsApp Multi-Instance REST API',
      description: 'API REST Multi-Instâncias de alta performance para WhatsApp Web (estilo Evolution / Z-API), implementada em Node.js com criptografia Noise XX, Signal Protocol E2EE e Envio de Mídias para CDN.',
      version: '1.0.0'
    },
    tags: [
      { name: 'Instance', description: 'Gerenciamento de Múltiplas Instâncias (Criar, Listar, Conectar, QR Code, Deletar)' },
      { name: 'Messages', description: 'Envio de Mensagens de Texto e Mídias (Imagens, Áudios/PTT, Documentos, Vídeos, Stickers)' },
      { name: 'Webhook', description: 'Configuração de Webhooks para Recepção de Eventos em Tempo Real' }
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

// Gerenciador de Instâncias
const manager = new InstanceManager({
  baseDir: process.env.SESSION_DIR || './sessions'
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
    description: 'WhatsApp Web Multi-Device & Multi-Instance REST API (Noise XX + Signal E2EE + Media CDN)',
    documentation: '/docs',
    instancesCount: manager.instances.size,
    endpoints: {
      docs: 'GET /docs',
      createInstance: 'POST /instance/create',
      listInstances: 'GET /instance/list',
      status: 'GET /instance/status/:instanceName',
      qr: 'GET /instance/qr/:instanceName',
      sendText: 'POST /message/send-text/:instanceName',
      sendMedia: 'POST /message/send-media/:instanceName',
      setWebhook: 'POST /webhook/set/:instanceName',
      findWebhook: 'GET /webhook/find/:instanceName'
    }
  };
});

// ==========================================
// 1. ROTAS DE GERENCIAMENTO DE INSTÂNCIAS
// ==========================================

// Criar Nova Instância
fastify.post('/instance/create', {
  schema: {
    tags: ['Instance'],
    summary: 'Criar Nova Instância',
    description: 'Cria e inicializa uma nova instância independente do WhatsApp (ex: "vendas", "suporte", "atendimento").',
    body: {
      type: 'object',
      required: ['instanceName'],
      properties: {
        instanceName: {
          type: 'string',
          description: 'Nome único identificador da instância',
          default: 'atendimento-01'
        }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          instance: {
            type: 'object',
            properties: {
              instanceName: { type: 'string' },
              status: { type: 'string' },
              connected: { type: 'boolean' }
            }
          }
        }
      }
    }
  }
}, async (request) => {
  const { instanceName } = request.body;
  return await manager.createInstance(instanceName);
});

// Listar Todas as Instâncias
fastify.get('/instance/list', {
  schema: {
    tags: ['Instance'],
    summary: 'Listar Todas as Instâncias',
    description: 'Retorna a lista de todas as instâncias ativas com seus respectivos status e números conectados.',
    response: {
      200: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            instanceName: { type: 'string' },
            status: { type: 'string' },
            connected: { type: 'boolean' },
            me: {
              type: 'object',
              nullable: true,
              properties: {
                id: { type: 'string' },
                lid: { type: 'string' }
              }
            },
            uptime: { type: 'number' },
            timestamp: { type: 'string' }
          }
        }
      }
    }
  }
}, async () => {
  return manager.listInstances();
});

// Obter Status de uma Instância
fastify.get('/instance/status/:instanceName', {
  schema: {
    tags: ['Instance'],
    summary: 'Status da Instância',
    description: 'Retorna o estado da conexão e dados da conta de uma instância específica.',
    params: {
      type: 'object',
      properties: {
        instanceName: { type: 'string', default: 'default' }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          instanceName: { type: 'string' },
          status: { type: 'string' },
          connected: { type: 'boolean' },
          me: {
            type: 'object',
            nullable: true,
            properties: {
              id: { type: 'string' },
              lid: { type: 'string' }
            }
          },
          uptime: { type: 'number' },
          timestamp: { type: 'string' }
        }
      }
    }
  }
}, async (request) => {
  const instance = manager.getInstance(request.params.instanceName);
  return instance.getStatus();
});

fastify.get('/instance/status', {
  schema: {
    tags: ['Instance'],
    summary: 'Status da Instância Padrão',
    description: 'Retorna o status da instância padrão ("default").'
  }
}, async () => {
  const instance = manager.getInstance('default');
  return instance.getStatus();
});

// Obter QR Code de uma Instância
fastify.get('/instance/qr/:instanceName', {
  schema: {
    tags: ['Instance'],
    summary: 'Obter QR Code da Instância',
    description: 'Retorna o QR Code ativo em JSON (base64) para pareamento no WhatsApp.',
    params: {
      type: 'object',
      properties: {
        instanceName: { type: 'string', default: 'default' }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          instanceName: { type: 'string' },
          status: { type: 'string' },
          qr: { type: 'string', nullable: true },
          qrBase64: { type: 'string', nullable: true }
        }
      }
    }
  }
}, async (request) => {
  const instance = manager.getInstance(request.params.instanceName);
  return instance.getQR();
});

fastify.get('/instance/qr', {
  schema: {
    tags: ['Instance'],
    summary: 'Obter QR Code da Instância Padrão',
    description: 'Retorna o QR Code da instância padrão ("default").'
  }
}, async () => {
  const instance = manager.getInstance('default');
  return instance.getQR();
});

// Conectar / Reconectar Instância
fastify.post('/instance/connect/:instanceName', {
  schema: {
    tags: ['Instance'],
    summary: 'Conectar Instância',
    description: 'Inicia o processo de conexão ou gera um novo QR Code para a instância.',
    params: {
      type: 'object',
      properties: {
        instanceName: { type: 'string', default: 'default' }
      }
    }
  }
}, async (request) => {
  const instance = manager.getInstance(request.params.instanceName);
  if (instance.status === 'open') {
    return { status: 'ALREADY_CONNECTED', message: `Instância "${instance.name}" já está conectada.` };
  }
  await instance.init();
  return { status: 'CONNECTING', message: `Conexão iniciada para a instância "${instance.name}".` };
});

fastify.post('/instance/connect', {
  schema: {
    tags: ['Instance'],
    summary: 'Conectar Instância Padrão'
  }
}, async () => {
  const instance = manager.getInstance('default');
  if (instance.status === 'open') {
    return { status: 'ALREADY_CONNECTED', message: 'Instância "default" já está conectada.' };
  }
  await instance.init();
  return { status: 'CONNECTING', message: 'Conexão iniciada para a instância "default".' };
});

// Logout da Instância
fastify.post('/instance/logout/:instanceName', {
  schema: {
    tags: ['Instance'],
    summary: 'Desconectar Instância',
    description: 'Encerra a conexão e limpa a sessão da instância especificada.',
    params: {
      type: 'object',
      properties: {
        instanceName: { type: 'string', default: 'default' }
      }
    }
  }
}, async (request) => {
  const instance = manager.getInstance(request.params.instanceName);
  await instance.logout();
  return { status: 'LOGGED_OUT', message: `Instância "${instance.name}" desconectada com sucesso.` };
});

fastify.post('/instance/logout', {
  schema: {
    tags: ['Instance'],
    summary: 'Desconectar Instância Padrão'
  }
}, async () => {
  const instance = manager.getInstance('default');
  await instance.logout();
  return { status: 'LOGGED_OUT', message: 'Instância "default" desconectada com sucesso.' };
});

// Deletar Instância
fastify.delete('/instance/delete/:instanceName', {
  schema: {
    tags: ['Instance'],
    summary: 'Deletar Instância',
    description: 'Desconecta e apaga permanentemente a instância e seus arquivos de sessão.',
    params: {
      type: 'object',
      properties: {
        instanceName: { type: 'string' }
      }
    }
  }
}, async (request) => {
  return await manager.deleteInstance(request.params.instanceName);
});

// ==========================================
// 2. ROTAS DE ENVIO DE MENSAGENS E MÍDIAS
// ==========================================

// Enviar Mensagem de Texto com nome de instância na URL
fastify.post('/message/send-text/:instanceName', {
  schema: {
    tags: ['Messages'],
    summary: 'Enviar Mensagem de Texto por Instância',
    description: 'Envia uma mensagem de texto cifrada com Signal Protocol E2EE utilizando uma instância específica.',
    params: {
      type: 'object',
      properties: {
        instanceName: { type: 'string', default: 'default' }
      }
    },
    body: {
      type: 'object',
      required: ['number', 'text'],
      properties: {
        number: {
          type: 'string',
          description: 'Número do destinatário com DDD (ex: "99991081780" ou "559991081780")'
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
          instanceName: { type: 'string' },
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
  const instanceName = request.params.instanceName || 'default';
  const { number, text, message } = request.body;
  const msgContent = text || message;

  if (!msgContent || typeof msgContent !== 'string' || !msgContent.trim()) {
    reply.status(400);
    return { error: 'O campo "text" é obrigatório e não pode ser vazio.' };
  }

  try {
    const instance = manager.getInstance(instanceName);
    const result = await instance.sendMessage(number, msgContent);
    return {
      status: 'SUCCESS',
      instanceName,
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

// Enviar Mensagem de Texto na rota genérica
fastify.post('/message/send-text', {
  schema: {
    tags: ['Messages'],
    summary: 'Enviar Mensagem de Texto',
    description: 'Envia uma mensagem de texto cifrada com Signal Protocol E2EE. Opcionalmente informe "instanceName" no body (padrão: "default").',
    body: {
      type: 'object',
      required: ['number', 'text'],
      properties: {
        instanceName: {
          type: 'string',
          description: 'Nome da instância que enviará a mensagem (padrão: "default")',
          default: 'default'
        },
        number: {
          type: 'string',
          description: 'Número do destinatário com DDD (ex: "99991081780" ou "559991081780")'
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
          instanceName: { type: 'string' },
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
  const { instanceName = 'default', number, text, message } = request.body;
  const msgContent = text || message;

  if (!msgContent || typeof msgContent !== 'string' || !msgContent.trim()) {
    reply.status(400);
    return { error: 'O campo "text" é obrigatório e não pode ser vazio.' };
  }

  try {
    const instance = manager.getInstance(instanceName);
    const result = await instance.sendMessage(number, msgContent);
    return {
      status: 'SUCCESS',
      instanceName: instance.name,
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

// Enviar Mídia por Instância
fastify.post('/message/send-media/:instanceName', {
  schema: {
    tags: ['Messages'],
    summary: 'Enviar Mídia por Instância',
    description: 'Envia imagem, áudio/gravação de voz (PTT), documento/PDF, vídeo ou figurinha (sticker) com upload seguro para a CDN do WhatsApp.',
    params: {
      type: 'object',
      properties: {
        instanceName: { type: 'string', default: 'default' }
      }
    },
    body: {
      type: 'object',
      required: ['number', 'type', 'media'],
      properties: {
        number: {
          type: 'string',
          description: 'Número do destinatário com DDD (ex: "99991081780" ou "559991081780")'
        },
        type: {
          type: 'string',
          enum: ['image', 'audio', 'document', 'video', 'sticker'],
          description: 'Tipo de mídia a ser enviada',
          default: 'image'
        },
        media: {
          type: 'string',
          description: 'URL pública (http/https) ou Base64 (data:mimetype;base64,...)',
          default: 'https://images.unsplash.com/photo-1579202673506-ca3ce28943ef?w=500'
        },
        caption: {
          type: 'string',
          description: 'Legenda para imagens ou vídeos (opcional)'
        },
        fileName: {
          type: 'string',
          description: 'Nome do arquivo (ex: "relatorio.pdf") para documentos'
        },
        mimetype: {
          type: 'string',
          description: 'Mimetype explícito (ex: "image/jpeg", "application/pdf")'
        },
        ptt: {
          type: 'boolean',
          description: 'True se for áudio de gravação de voz (Push-To-Talk) com waveform',
          default: false
        }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          instanceName: { type: 'string' },
          messageId: { type: 'string' },
          to: { type: 'string' },
          type: { type: 'string' },
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
  const instanceName = request.params.instanceName || 'default';
  const { number, type, media, caption, fileName, mimetype, ptt, seconds } = request.body;

  if (!number || !type || !media) {
    reply.status(400);
    return { error: 'Os campos "number", "type" e "media" são obrigatórios.' };
  }

  try {
    const instance = manager.getInstance(instanceName);
    const result = await instance.sendMedia(number, {
      type,
      media,
      caption,
      fileName,
      mimetype,
      ptt,
      seconds
    });
    return {
      status: 'SUCCESS',
      instanceName,
      messageId: result.key?.id,
      to: result.key?.remoteJid,
      type,
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

// Enviar Mídia na rota genérica
fastify.post('/message/send-media', {
  schema: {
    tags: ['Messages'],
    summary: 'Enviar Mídia',
    description: 'Envia imagem, áudio/PTT, documento, vídeo ou figurinha. Opcionalmente informe "instanceName" no body.',
    body: {
      type: 'object',
      required: ['number', 'type', 'media'],
      properties: {
        instanceName: {
          type: 'string',
          description: 'Nome da instância (padrão: "default")',
          default: 'default'
        },
        number: {
          type: 'string',
          description: 'Número do destinatário com DDD (ex: "99991081780" ou "559991081780")'
        },
        type: {
          type: 'string',
          enum: ['image', 'audio', 'document', 'video', 'sticker'],
          description: 'Tipo de mídia a ser enviada',
          default: 'image'
        },
        media: {
          type: 'string',
          description: 'URL pública (http/https) ou Base64 (data:mimetype;base64,...)',
          default: 'https://images.unsplash.com/photo-1579202673506-ca3ce28943ef?w=500'
        },
        caption: {
          type: 'string',
          description: 'Legenda para imagens ou vídeos (opcional)'
        },
        fileName: {
          type: 'string',
          description: 'Nome do arquivo (ex: "relatorio.pdf") para documentos'
        },
        mimetype: {
          type: 'string',
          description: 'Mimetype explícito (ex: "image/jpeg", "application/pdf")'
        },
        ptt: {
          type: 'boolean',
          description: 'True se for áudio de gravação de voz (Push-To-Talk)',
          default: false
        }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          instanceName: { type: 'string' },
          messageId: { type: 'string' },
          to: { type: 'string' },
          type: { type: 'string' },
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
  const { instanceName = 'default', number, type, media, caption, fileName, mimetype, ptt, seconds } = request.body;

  if (!number || !type || !media) {
    reply.status(400);
    return { error: 'Os campos "number", "type" e "media" são obrigatórios.' };
  }

  try {
    const instance = manager.getInstance(instanceName);
    const result = await instance.sendMedia(number, {
      type,
      media,
      caption,
      fileName,
      mimetype,
      ptt,
      seconds
    });
    return {
      status: 'SUCCESS',
      instanceName: instance.name,
      messageId: result.key?.id,
      to: result.key?.remoteJid,
      type,
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

// ==========================================
// 3. ROTAS DE WEBHOOK
// ==========================================

// Configurar Webhook por Instância
fastify.post('/webhook/set/:instanceName', {
  schema: {
    tags: ['Webhook'],
    summary: 'Configurar Webhook da Instância',
    description: 'Configura o endpoint HTTP para receber eventos em tempo real (novas mensagens, atualizações de conexão, recibos de leitura).',
    params: {
      type: 'object',
      properties: {
        instanceName: { type: 'string', default: 'default' }
      }
    },
    body: {
      type: 'object',
      required: ['url'],
      properties: {
        url: {
          type: 'string',
          description: 'URL do endpoint HTTP que receberá os POSTs de webhook (ex: https://webhook.site/...)',
          default: 'https://webhook.site/sua-url-aqui'
        },
        enabled: {
          type: 'boolean',
          description: 'Habilitar ou desabilitar o disparo de webhooks',
          default: true
        },
        events: {
          type: 'array',
          description: 'Lista de eventos a serem enviados',
          items: { type: 'string' },
          default: ['messages.upsert', 'connection.update', 'receipts.update', 'presence.update']
        },
        headers: {
          type: 'object',
          description: 'Headers HTTP customizados opcionais (ex: Authorization)',
          additionalProperties: true
        }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          webhook: {
            type: 'object',
            properties: {
              instanceName: { type: 'string' },
              url: { type: 'string' },
              enabled: { type: 'boolean' },
              events: { type: 'array', items: { type: 'string' } },
              headers: { type: 'object', additionalProperties: true }
            }
          }
        }
      }
    }
  }
}, async (request) => {
  const instanceName = request.params.instanceName || 'default';
  const instance = manager.getInstance(instanceName);
  const webhook = await instance.setWebhook(request.body);
  return { status: 'SUCCESS', webhook };
});

fastify.post('/webhook/set', {
  schema: {
    tags: ['Webhook'],
    summary: 'Configurar Webhook da Instância Padrão'
  }
}, async (request) => {
  const instance = manager.getInstance('default');
  const webhook = await instance.setWebhook(request.body);
  return { status: 'SUCCESS', webhook };
});

// Consultar Webhook por Instância
fastify.get('/webhook/find/:instanceName', {
  schema: {
    tags: ['Webhook'],
    summary: 'Consultar Webhook da Instância',
    description: 'Retorna a configuração atual de webhook da instância especificada.',
    params: {
      type: 'object',
      properties: {
        instanceName: { type: 'string', default: 'default' }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          instanceName: { type: 'string' },
          url: { type: 'string' },
          enabled: { type: 'boolean' },
          events: { type: 'array', items: { type: 'string' } },
          headers: { type: 'object', additionalProperties: true }
        }
      }
    }
  }
}, async (request) => {
  const instanceName = request.params.instanceName || 'default';
  const instance = manager.getInstance(instanceName);
  return instance.getWebhook();
});

fastify.get('/webhook/find', {
  schema: {
    tags: ['Webhook'],
    summary: 'Consultar Webhook da Instância Padrão'
  }
}, async () => {
  const instance = manager.getInstance('default');
  return instance.getWebhook();
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

try {
  await manager.initAll();
  await fastify.listen({ port: PORT, host: HOST });
  console.log(`
🚀 standard-api Multi-Instance REST rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`   - 📖 Swagger Docs:       http://localhost:${PORT}/docs`);
  console.log(`   - 📋 Listar Instâncias:  GET  http://localhost:${PORT}/instance/list`);
  console.log(`   - ➕ Criar Instância:    POST http://localhost:${PORT}/instance/create`);
  console.log(`   - 🔔 Configurar Webhook: POST http://localhost:${PORT}/webhook/set/:instanceName`);
  console.log(`   - 💬 Enviar Mensagem:    POST http://localhost:${PORT}/message/send-text/:instanceName`);
  console.log(`   - 🖼️ Enviar Mídia:       POST http://localhost:${PORT}/message/send-media/:instanceName
`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
