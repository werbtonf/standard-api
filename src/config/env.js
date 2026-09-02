export const env = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  HOST: process.env.HOST || '0.0.0.0',
  SESSION_DIR: process.env.SESSION_DIR || './sessions',
  GLOBAL_API_KEY: process.env.GLOBAL_API_KEY || '',
  DATABASE_URL: process.env.DATABASE_URL || '',
  DATABASE_ENABLED: process.env.DATABASE_ENABLED === 'true' || Boolean(process.env.DATABASE_URL),
  REDIS_URL: process.env.REDIS_URL || '',
  REDIS_ENABLED: process.env.REDIS_ENABLED === 'true' || Boolean(process.env.REDIS_URL),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  LOG_STANZA: process.env.LOG_STANZA === 'true'
};
