import Redis from 'ioredis';
import { logger } from './logger.js';

let redisClient = null;
let isConnected = false;

export async function initRedis() {
  const redisUrl = process.env.REDIS_URL;
  const redisEnabled = process.env.REDIS_ENABLED === 'true' || Boolean(redisUrl);

  if (!redisEnabled || !redisUrl) {
    logger.redis('Redis nao configurado. Operando sem cache distribuido.');
    return null;
  }

  try {
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      retryStrategy: (times) => {
        if (times > 3) return null; // stop retrying after 3 attempts
        return Math.min(times * 200, 1000);
      },
      lazyConnect: true
    });

    redisClient.on('error', (err) => {
      // suprime erros repetitivos de reconexao
    });

    await redisClient.connect();
    logger.redis('Conectado ao Redis com sucesso.');
    isConnected = true;
    return redisClient;
  } catch (err) {
    logger.warn('redis', 'Nao foi possivel conectar ao Redis: ' + err.message);
    redisClient = null;
    isConnected = false;
    return null;
  }
}

export function getRedis() {
  return redisClient;
}

export function isRedisConnected() {
  return isConnected;
}

export async function cacheSet(key, value, ttlSeconds = 600) {
  if (!isConnected || !redisClient) return;
  try {
    const val = typeof value === 'string' ? value : JSON.stringify(value);
    await redisClient.set(key, val, 'EX', ttlSeconds);
  } catch (e) {}
}

export async function cacheGet(key) {
  if (!isConnected || !redisClient) return null;
  try {
    const val = await redisClient.get(key);
    if (!val) return null;
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  } catch (e) {
    return null;
  }
}
