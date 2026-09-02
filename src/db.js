import pg from 'pg';
import { logger } from './logger.js';

const { Pool } = pg;

let pool = null;
let isConnected = false;

export async function initDatabase() {
  const dbUrl = process.env.DATABASE_URL;
  const dbEnabled = process.env.DATABASE_ENABLED === 'true' || Boolean(dbUrl);

  if (!dbEnabled || !dbUrl) {
    logger.db('PostgreSQL nao configurado. Operando em modo de arquivos locais.');
    return null;
  }

  try {
    pool = new Pool({
      connectionString: dbUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });

    const client = await pool.connect();
    logger.db('Conectado ao PostgreSQL com sucesso.');

    // Inicializa as tabelas essenciais
    await client.query(`
      CREATE TABLE IF NOT EXISTS instances (
        name VARCHAR(100) PRIMARY KEY,
        status VARCHAR(50) DEFAULT 'disconnected',
        apikey VARCHAR(255),
        owner_jid VARCHAR(100),
        webhook_url TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(100) PRIMARY KEY,
        instance_name VARCHAR(100) NOT NULL,
        remote_jid VARCHAR(100) NOT NULL,
        from_me BOOLEAN DEFAULT FALSE,
        message_type VARCHAR(50) DEFAULT 'text',
        content JSONB,
        status VARCHAR(50) DEFAULT 'PENDING',
        timestamp BIGINT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS contacts (
        jid VARCHAR(100) NOT NULL,
        instance_name VARCHAR(100) NOT NULL,
        name VARCHAR(255),
        push_name VARCHAR(255),
        profile_picture_url TEXT,
        status_text TEXT,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (jid, instance_name)
      );

      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS profile_picture_url TEXT;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS status_text TEXT;

      CREATE INDEX IF NOT EXISTS idx_messages_instance ON messages(instance_name);
      CREATE INDEX IF NOT EXISTS idx_messages_remote ON messages(remote_jid);
      CREATE INDEX IF NOT EXISTS idx_contacts_instance ON contacts(instance_name);
    `);

    client.release();
    isConnected = true;
    return pool;
  } catch (err) {
    console.warn('[db] Nao foi possivel conectar ao PostgreSQL:', err.message, '- Operando com fallback local.');
    pool = null;
    isConnected = false;
    return null;
  }
}

export function getDb() {
  return pool;
}

export function isDbConnected() {
  return isConnected;
}

export async function saveMessageToDb(instanceName, msgInfo) {
  if (!isConnected || !pool) return;
  try {
    const id = msgInfo.key?.id;
    const remoteJid = msgInfo.key?.remoteJid;
    const fromMe = Boolean(msgInfo.key?.fromMe);
    const timestamp = msgInfo.messageTimestamp || Math.floor(Date.now() / 1000);
    const content = msgInfo.message || {};
    const messageType = Object.keys(content)[0] || 'text';

    await pool.query(
      `INSERT INTO messages (id, instance_name, remote_jid, from_me, message_type, content, status, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, content = EXCLUDED.content`,
      [id, instanceName, remoteJid, fromMe, messageType, JSON.stringify(content), 'DELIVERED', timestamp]
    );
  } catch (e) {
    console.warn('[db saveMessage error]', e.message);
  }
}

export async function upsertInstanceInDb(instanceName, data = {}) {
  if (!isConnected || !pool) return;
  try {
    const { status, apikey, ownerJid, webhookUrl } = data;
    await pool.query(
      `INSERT INTO instances (name, status, apikey, owner_jid, webhook_url, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (name) DO UPDATE SET
         status = COALESCE($2, instances.status),
         apikey = COALESCE($3, instances.apikey),
         owner_jid = COALESCE($4, instances.owner_jid),
         webhook_url = COALESCE($5, instances.webhook_url),
         updated_at = CURRENT_TIMESTAMP`,
      [instanceName, status || 'disconnected', apikey || null, ownerJid || null, webhookUrl || null]
    );
  } catch (e) {
    console.warn('[db upsertInstance error]', e.message);
  }
}

export async function upsertContactInDb(instanceName, contactData = {}) {
  if (!isConnected || !pool) return;
  try {
    const { jid, name, pushName, profilePictureUrl, statusText } = contactData;
    if (!jid) return;
    await pool.query(
      `INSERT INTO contacts (jid, instance_name, name, push_name, profile_picture_url, status_text, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (jid, instance_name) DO UPDATE SET
         name = COALESCE($3, contacts.name),
         push_name = COALESCE($4, contacts.push_name),
         profile_picture_url = COALESCE($5, contacts.profile_picture_url),
         status_text = COALESCE($6, contacts.status_text),
         updated_at = CURRENT_TIMESTAMP`,
      [jid, instanceName, name || null, pushName || null, profilePictureUrl || null, statusText || null]
    );
  } catch (e) {
    logger.debug('db', `Erro ao salvar contato no DB: ${e.message}`);
  }
}

export async function listContactsFromDb(instanceName, limit = 50, offset = 0) {
  if (!isConnected || !pool) return [];
  try {
    const res = await pool.query(
      `SELECT jid, instance_name, name, push_name, profile_picture_url, status_text, updated_at
       FROM contacts
       WHERE instance_name = $1
       ORDER BY updated_at DESC
       LIMIT $2 OFFSET $3`,
      [instanceName, limit, offset]
    );
    return res.rows;
  } catch (e) {
    logger.debug('db', `Erro ao listar contatos do DB: ${e.message}`);
    return [];
  }
}

export async function deleteInstanceFromDb(instanceName) {
  if (!isConnected || !pool) return;
  try {
    await pool.query('DELETE FROM instances WHERE name = $1', [instanceName]);
  } catch (e) {
    logger.debug('db', `Erro ao deletar instancia do DB: ${e.message}`);
  }
}



