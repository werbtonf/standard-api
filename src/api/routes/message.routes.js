export default async function messageRoutes(fastify, options) {
  const { manager } = options;

  // Enviar Mensagem de Texto por Instância
  fastify.post('/message/send-text/:instanceName', {
    schema: {
      tags: ['Messages'],
      summary: 'Enviar Mensagem de Texto por Instância',
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
}
