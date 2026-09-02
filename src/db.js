import pg from 'pg';

const { Pool } = pg;

let pool = null;
let isConnected = false;

export async function initDatabase() {
  const dbUrl = process.env.DATABASE_URL;
  const dbEnabled = process.env.DATABASE_ENABLED === 'true' || Boolean(dbUrl);

  if (!dbEnabled || !dbUrl) {
    console.log('[db] PostgreSQL nao configurado ou desabilitado. Operando em modo de arquivos locais.');
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
    console.log('[db] Conectado ao PostgreSQL com sucesso.');

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
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (jid, instance_name)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_instance ON messages(instance_name);
      CREATE INDEX IF NOT EXISTS idx_messages_remote ON messages(remote_jid);
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

export async function updateMessageStatusInDb(id, status) {
  if (!isConnected || !pool) return;
  try {
    await pool.query('UPDATE messages SET status = $1 WHERE id = $2', [status, id]);
  } catch (e) {}
}
