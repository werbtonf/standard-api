import instanceRoutes from './instance.routes.js';
import messageRoutes from './message.routes.js';
import contactRoutes from './contact.routes.js';
import webhookRoutes from './webhook.routes.js';

export default async function registerRoutes(fastify, options) {
  const { manager } = options;

  // Erro de "instância não encontrada" deve virar 404 (não 500) para o
  // consumidor poder auto-criar a instância (padrão Flowbash _ensure).
  fastify.setErrorHandler((err, request, reply) => {
    if (err instanceof Error && /não encontrada|não encontrado/i.test(err.message)) {
      reply.code(404);
      return { error: err.message };
    }
    reply.send(err);
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

  // Registra sub-rotas
  await fastify.register(instanceRoutes, { manager });
  await fastify.register(messageRoutes, { manager });
  await fastify.register(contactRoutes, { manager });
  await fastify.register(webhookRoutes, { manager });
}
