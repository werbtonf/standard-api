export default async function contactRoutes(fastify, options) {
  const { manager } = options;

  // Verificar se número(s) existe(m) no WhatsApp
  fastify.post('/contact/check-number/:instanceName', {
    schema: {
      tags: ['Contact'],
      summary: 'Verificar Número no WhatsApp',
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

  // Alias para fetchProfilePictureUrl (compatibilidade Evolution/Baileys)
  fastify.post('/chat/fetchProfilePictureUrl/:instanceName', async (request) => {
    const instanceName = request.params.instanceName || 'default';
    const instance = manager.getInstance(instanceName);
    const { number, jid } = request.body || {};
    return await instance.getProfilePicture(number || jid);
  });

  // Sincronização de Contatos / Chats (findContacts e findChats)
  fastify.post('/chat/findContacts/:instanceName', async (request) => {
    const instanceName = request.params.instanceName || 'default';
    const instance = manager.getInstance(instanceName);
    const contacts = await instance.listContacts(500, 0);
    return { contacts };
  });

  fastify.post('/chat/findChats/:instanceName', async (request) => {
    const instanceName = request.params.instanceName || 'default';
    const instance = manager.getInstance(instanceName);
    const contacts = await instance.listContacts(500, 0);
    return { chats: contacts };
  });

  // Definir Presença em Chat Individual (digitando / gravando áudio)
  fastify.post('/chat/sendPresence/:instanceName', async (request) => {
    const instanceName = request.params.instanceName || 'default';
    const instance = manager.getInstance(instanceName);
    const body = request.body || {};
    const presence = body.presence || 'composing';
    const number = body.number || body.jid || body.remoteJid;
    return await instance.sendPresence(presence, number);
  });
}
