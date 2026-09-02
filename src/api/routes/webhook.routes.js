export default async function webhookRoutes(fastify, options) {
  const { manager } = options;

  // Configurar Webhook por Instância
  fastify.post('/webhook/set/:instanceName', {
    schema: {
      tags: ['Webhook'],
      summary: 'Configurar Webhook da Instância',
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
}
