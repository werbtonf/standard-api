import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { InstanceManager } from './instance.js';
import { initDatabase, isDbConnected } from './db.js';
import { initRedis, isRedisConnected } from './redis.js';
import { logger } from './logger.js';

const fastify = Fastify({
  logger: false,
  disableRequestLogging: true,
  ajv: {
    customOptions: {
      strict: false
    }
  }
});

await fastify.register(cors, {
  origin: '*'
});

// Configuração do Swagger OpenAPI com suporte a API Key
await fastify.register(swagger, {
  openapi: {
    info: {
      title: 'standard-api - WhatsApp Multi-Instance REST API',
      description: 'API REST Multi-Instâncias de alta performance para WhatsApp Web (estilo Evolution / Z-API), implementada em Node.js com criptografia Noise XX, Signal Protocol E2EE, Envio de Mídias para CDN e Segurança por API Key.',
      version: '1.0.0'
    },
    components: {
      securitySchemes: {
        apiKeyHeader: {
          type: 'apiKey',
          name: 'apikey',
          in: 'header',
          description: 'Chave de autenticação (GLOBAL_API_KEY ou API Key da Instância)'
        }
      }
    },
    security: [
      { apiKeyHeader: [] }
    ],
    tags: [
      { name: 'Instance', description: 'Gerenciamento de Múltiplas Instâncias (Criar, Listar, Conectar, QR Code, Deletar)' },
      { name: 'Messages', description: 'Envio de Mensagens de Texto e Mídias (Imagens, Áudios/PTT, Documentos, Vídeos, Stickers)' },
      { name: 'Contact', description: 'Consulta de Números no WhatsApp, Foto de Perfil, Recado/Bio e Bloqueio' },
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

const GLOBAL_API_KEY = process.env.GLOBAL_API_KEY || '';

// Hook de Autenticação Global / Multi-Tenant via API Key
fastify.addHook('preHandler', async (request, reply) => {
  const url = request.raw.url || '';
  // Rotas públicas (documentação, swagger json/static e raiz)
  if (
    url === '/' ||
    url.startsWith('/docs') ||
    url.startsWith('/public') ||
    request.method === 'OPTIONS'
  ) {
    return;
  }

  const providedKey = request.headers['apikey'] || request.headers['x-api-key'] || request.query?.apikey;

  // 1. Valida Global API Key (Acesso irrestrito a todas as rotas)
  if (GLOBAL_API_KEY && providedKey === GLOBAL_API_KEY) {
    return;
  }

  // 2. Valida API Key da Instância
  const instanceName = request.params?.instanceName || request.body?.instanceName;
  if (instanceName && manager.hasInstance(instanceName)) {
    try {
      const instance = manager.getInstance(instanceName);
      if (instance.apikey && providedKey === instance.apikey) {
        return;
      }
    } catch (e) {}
  }

  // Se GLOBAL_API_KEY está configurada e a chave não foi válida, rejeita
  if (GLOBAL_API_KEY) {
    return reply.code(401).send({
      status: 'UNAUTHORIZED',
      error: 'Acesso não autorizado. Forneça uma API Key válida no header "apikey" ou "x-api-key".'
    });
  }
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
      connect: 'POST /instance/connect/:instanceName',
      logout: 'POST /instance/logout/:instanceName',
      delete: 'DELETE /instance/delete/:instanceName',
      sendText: 'POST /message/send-text/:instanceName',
      sendMedia: 'POST /message/send-media/:instanceName',
      setWebhook: 'POST /webhook/set/:instanceName',
      findWebhook: 'GET /webhook/find/:instanceName',
      checkNumber: 'POST /contact/check-number/:instanceName',
      profilePicture: 'POST /contact/profile-picture/:instanceName',
      contactStatus: 'POST /contact/status/:instanceName',
      blockContact: 'POST /contact/block/:instanceName',
      blocklist: 'GET /contact/blocklist/:instanceName',
      updateProfileStatus: 'POST /contact/update-profile-status/:instanceName',
      listContacts: 'GET /contact/list/:instanceName'
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
        },
        apikey: {
          type: 'string',
          description: 'Chave de API opcional exclusiva para esta instância (Multi-Tenant)'
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
              apikey: { type: 'string', nullable: true },
              connected: { type: 'boolean' }
            }
          }
        }
      }
    }
  }
}, async (request) => {
  const { instanceName, apikey } = request.body;
  return await manager.createInstance(instanceName, { apikey });
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

// ==========================================
// 4. ROTAS DO MÓDULO DE CONTATOS
// ==========================================

// Verificar se número(s) existe(m) no WhatsApp
fastify.post('/contact/check-number/:instanceName', {
  schema: {
    tags: ['Contact'],
    summary: 'Verificar Número no WhatsApp',
    description: 'Verifica se um ou mais números estão registrados no WhatsApp e obtém seus JIDs canônicos.',
    params: {
      type: 'object',
      properties: {
        instanceName: { type: 'string', default: 'default' }
      }
    },
    body: {
      type: 'object',
      properties: {
        number: { type: 'string', description: 'Número único (ex: 5599991081780)' },
        numbers: { type: 'array', items: { type: 'string' }, description: 'Lista de múltiplos números para checagem' }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          instanceName: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                exists: { type: 'boolean' },
                jid: { type: 'string', nullable: true },
                number: { type: 'string' },
                status: { type: 'string', nullable: true }
              }
            }
          }
        }
      }
    }
  }
}, async (request) => {
  const instanceName = request.params.instanceName || 'default';
  const instance = manager.getInstance(instanceName);
  const { number, numbers } = request.body || {};

  const targets = [];
  if (typeof number === 'string' && number.trim()) {
    targets.push(number.trim());
  }
  if (Array.isArray(numbers)) {
    for (const n of numbers) {
      if (typeof n === 'string' && n.trim() && !targets.includes(n.trim())) {
        targets.push(n.trim());
      }
    }
  }

  if (targets.length === 0) {
    throw new Error('Forneça "number" (string) ou "numbers" (array de strings).');
  }

  const results = await instance.checkNumbers(targets);

  return {
    status: 'SUCCESS',
    instanceName,
    results
  };
});

// Obter Foto de Perfil do Contato
fastify.post('/contact/profile-picture/:instanceName', {
  schema: {
    tags: ['Contact'],
    summary: 'Obter Foto de Perfil do Contato',
    description: 'Recupera a URL pública direta da foto de perfil de um contato ou grupo no CDN do WhatsApp.',
    params: {
      type: 'object',
      properties: {
        instanceName: { type: 'string', default: 'default' }
      }
    },
    body: {
      type: 'object',
      required: ['number'],
      properties: {
        number: { type: 'string', description: 'Número do contato ou JID (ex: 5599991081780 ou 55...@s.whatsapp.net)' },
        type: { type: 'string', enum: ['image', 'preview'], default: 'image', description: 'Alta resolução (image) ou miniatura (preview)' }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          instanceName: { type: 'string' },
          number: { type: 'string' },
          profilePictureUrl: { type: 'string', nullable: true }
        }
      }
    }
  }
}, async (request) => {
  const instanceName = request.params.instanceName || 'default';
  const instance = manager.getInstance(instanceName);
  const { number, type } = request.body;
  return await instance.getProfilePicture(number, type);
});

fastify.get('/contact/profile-picture/:instanceName/:number', {
  schema: {
    tags: ['Contact'],
    summary: 'Obter Foto de Perfil por URL'
  }
}, async (request) => {
  const { instanceName, number } = request.params;
  const instance = manager.getInstance(instanceName);
  return await instance.getProfilePicture(number);
});

// Obter Status / Recado / Bio do Contato
fastify.post('/contact/status/:instanceName', {
  schema: {
    tags: ['Contact'],
    summary: 'Obter Status/Recado do Contato',
    description: 'Consulta o texto de "Sobre" / Recado do perfil de um contato.',
    params: {
      type: 'object',
      properties: {
        instanceName: { type: 'string', default: 'default' }
      }
    },
    body: {
      type: 'object',
      required: ['number'],
      properties: {
        number: { type: 'string', description: 'Número ou JID do contato' }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          instanceName: { type: 'string' },
          jid: { type: 'string' },
          status: { type: 'string', nullable: true },
          setAt: { type: 'string', nullable: true }
        }
      }
    }
  }
}, async (request) => {
  const instanceName = request.params.instanceName || 'default';
  const instance = manager.getInstance(instanceName);
  const { number } = request.body;
  return await instance.getContactStatus(number);
});

fastify.get('/contact/status/:instanceName/:number', {
  schema: {
    tags: ['Contact'],
    summary: 'Obter Status/Recado por URL'
  }
}, async (request) => {
  const { instanceName, number } = request.params;
  const instance = manager.getInstance(instanceName);
  return await instance.getContactStatus(number);
});

// Bloquear ou Desbloquear Contato
fastify.post('/contact/block/:instanceName', {
  schema: {
    tags: ['Contact'],
    summary: 'Bloquear / Desbloquear Contato',
    description: 'Bloqueia ou desbloqueia um contato no WhatsApp da instância.',
    params: {
      type: 'object',
      properties: {
        instanceName: { type: 'string', default: 'default' }
      }
    },
    body: {
      type: 'object',
      required: ['number'],
      properties: {
        number: { type: 'string', description: 'Número ou JID do contato' },
        action: { type: 'string', enum: ['block', 'unblock'], default: 'block' }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          instanceName: { type: 'string' },
          jid: { type: 'string' },
          action: { type: 'string' },
          status: { type: 'string' }
        }
      }
    }
  }
}, async (request) => {
  const instanceName = request.params.instanceName || 'default';
  const instance = manager.getInstance(instanceName);
  const { number, action } = request.body;
  return await instance.blockContact(number, action || 'block');
});

// Obter Lista de Contatos Bloqueados
fastify.get('/contact/blocklist/:instanceName', {
  schema: {
    tags: ['Contact'],
    summary: 'Listar Contatos Bloqueados',
    description: 'Retorna a lista de todos os contatos bloqueados na conta do WhatsApp.',
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
          total: { type: 'integer' },
          blocklist: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
}, async (request) => {
  const instanceName = request.params.instanceName || 'default';
  const instance = manager.getInstance(instanceName);
  return await instance.getBlocklist();
});

// Atualizar Status / Recado do Próprio Perfil
fastify.post('/contact/update-profile-status/:instanceName', {
  schema: {
    tags: ['Contact'],
    summary: 'Atualizar Recado do Próprio Perfil',
    description: 'Altera o status/recado do WhatsApp da instância conectada.',
    params: {
      type: 'object',
      properties: {
        instanceName: { type: 'string', default: 'default' }
      }
    },
    body: {
      type: 'object',
      required: ['status'],
      properties: {
        status: { type: 'string', description: 'Novo texto de status/recado' }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          instanceName: { type: 'string' },
          status: { type: 'string' },
          updated: { type: 'boolean' }
        }
      }
    }
  }
}, async (request) => {
  const instanceName = request.params.instanceName || 'default';
  const instance = manager.getInstance(instanceName);
  const { status } = request.body;
  return await instance.updateProfileStatus(status);
});

// Listar Contatos Salvos no PostgreSQL
fastify.get('/contact/list/:instanceName', {
  schema: {
    tags: ['Contact'],
    summary: 'Listar Contatos Salvos no Banco',
    description: 'Retorna os contatos registrados e salvos no PostgreSQL para a instância.',
    params: {
      type: 'object',
      properties: {
        instanceName: { type: 'string', default: 'default' }
      }
    },
    querystring: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 50 },
        offset: { type: 'integer', default: 0 }
      }
    },
    response: {
      200: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            jid: { type: 'string' },
            instance_name: { type: 'string' },
            name: { type: 'string', nullable: true },
            push_name: { type: 'string', nullable: true },
            profile_picture_url: { type: 'string', nullable: true },
            status_text: { type: 'string', nullable: true },
            updated_at: { type: 'string' }
          }
        }
      }
    }
  }
}, async (request) => {
  const instanceName = request.params.instanceName || 'default';
  const instance = manager.getInstance(instanceName);
  const limit = parseInt(request.query?.limit || '50', 10);
  const offset = parseInt(request.query?.offset || '0', 10);
  return await instance.listContacts(limit, offset);
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

try {
  await initDatabase();
  await initRedis();
  await manager.initAll();
  await fastify.listen({ port: PORT, host: HOST });
  
  logger.banner({
    port: PORT,
    host: HOST === '0.0.0.0' ? 'localhost' : HOST,
    dbConnected: isDbConnected(),
    redisConnected: isRedisConnected(),
    hasApiKey: Boolean(GLOBAL_API_KEY)
  });
  logger.server(`Servidor HTTP pronto para receber requisicoes.`);
} catch (err) {
  logger.error('server', 'Falha ao iniciar servidor Fastify:', err);
  process.exit(1);
}
