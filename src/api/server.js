import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { initDatabase, isDbConnected } from '../database/postgres.js';
import { initRedis, isRedisConnected } from '../database/redis.js';
import { InstanceManager } from '../services/instance.manager.js';
import { createAuthHook } from './middlewares/auth.middleware.js';
import registerRoutes from './routes/index.js';

export async function createServer() {
  const fastify = Fastify({
    logger: false,
    bodyLimit: 100 * 1024 * 1024 // 100MB para envio de mídias/base64
  });

  await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  });

  // Configuração do Swagger OpenAPI
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Standard API',
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
        { name: 'Instance' },
        { name: 'Messages' },
        { name: 'Contact' },
        { name: 'Webhook' }
      ]
    }
  });

  // Interface Web do Swagger UI
  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      displayRequestDuration: true,
      filter: true
    },
    staticCSP: true,
    transformStaticCSP: (header) => header
  });

  // Gerenciador de Instâncias
  const manager = new InstanceManager({
    baseDir: env.SESSION_DIR
  });

  // Hook de Autenticação
  fastify.addHook('preHandler', createAuthHook(manager));

  // Registro de Rotas
  await fastify.register(registerRoutes, { manager });

  return { fastify, manager };
}

export async function startServer() {
  try {
    await initDatabase();
    await initRedis();

    const { fastify, manager } = await createServer();
    await manager.initAll();

    await fastify.listen({ port: env.PORT, host: env.HOST });

    logger.banner({
      port: env.PORT,
      host: env.HOST === '0.0.0.0' ? 'localhost' : env.HOST,
      dbConnected: isDbConnected(),
      redisConnected: isRedisConnected(),
      hasApiKey: Boolean(env.GLOBAL_API_KEY)
    });
    logger.server(`Servidor HTTP pronto para receber requisicoes.`);

    return { fastify, manager };
  } catch (err) {
    logger.error('server', 'Falha ao iniciar servidor Fastify:', err);
    process.exit(1);
  }
}
