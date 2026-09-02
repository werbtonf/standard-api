import { env } from '../../config/env.js';

export function createAuthHook(manager) {
  return async (request, reply) => {
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
    const globalKey = env.GLOBAL_API_KEY;

    // 1. Valida Global API Key (Acesso irrestrito a todas as rotas)
    if (globalKey && providedKey === globalKey) {
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
    if (globalKey) {
      return reply.code(401).send({
        status: 'UNAUTHORIZED',
        error: 'Acesso não autorizado. Forneça uma API Key válida no header "apikey" ou "x-api-key".'
      });
    }
  };
}
