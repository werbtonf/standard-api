export default async function instanceRoutes(fastify, options) {
  const { manager } = options;

  // Criar Nova Instância
  fastify.post('/instance/create', {
    schema: {
      tags: ['Instance'],
      summary: 'Criar Nova Instância',
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

  // Alias para Listar Instâncias (fetchInstances)
  fastify.get('/instance/fetchInstances', async () => {
    return manager.listInstances();
  });

  // Obter Estado da Conexão (connectionState)
  fastify.get('/instance/connectionState/:instanceName', async (request) => {
    const instance = manager.getInstance(request.params.instanceName);
    const state = instance.status === 'open' ? 'open' : (instance.status === 'qrcode' ? 'connecting' : 'close');
    return {
      instance: {
        instanceName: instance.name,
        state
      }
    };
  });

  // Obter QR Code ou Status de Conexão via GET /instance/connect/:instanceName
  fastify.get('/instance/connect/:instanceName', async (request) => {
    const instance = manager.getInstance(request.params.instanceName);
    if (instance.status !== 'open' && !instance.client) {
      instance.init().catch(() => {});
    }
    return {
      instance: {
        instanceName: instance.name,
        state: instance.status
      },
      status: instance.status,
      code: instance.qr,
      base64: instance.qrBase64,
      qr: instance.qr,
      qrBase64: instance.qrBase64
    };
  });

  // Reiniciar Instância
  fastify.post('/instance/restart/:instanceName', async (request) => {
    const instance = manager.getInstance(request.params.instanceName);
    return await instance.restart();
  });

  // Definir Presença Global da Instância
  fastify.post('/instance/setPresence/:instanceName', async (request) => {
    const instance = manager.getInstance(request.params.instanceName);
    const presence = request.body?.presence || 'available';
    return await instance.sendPresence(presence, null);
  });

  // Configurações da Instância
  fastify.post('/settings/set/:instanceName', async (request) => {
    const instanceName = request.params.instanceName;
    return { status: 'SUCCESS', instanceName, settings: request.body || {} };
  });
}
