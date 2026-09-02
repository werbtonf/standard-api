import { connectWA } from './client.js';
import { initAuthCreds, signPreKeys, normalizeCreds } from './auth.js';
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { logger } from './logger.js';
import { saveMessageToDb, upsertInstanceInDb, deleteInstanceFromDb } from './db.js';

export class WhatsAppInstance {
  constructor(name, options = {}) {
    this.name = name;
    this.baseDir = options.baseDir || './sessions';
    this.sessionDir = join(this.baseDir, this.name);
    this.sessionFile = join(this.sessionDir, 'session.json');
    this.webhookFile = join(this.sessionDir, 'webhook.json');
    this.configFile = join(this.sessionDir, 'config.json');
    this.apikey = options.apikey || null;
    this.client = null;
    this.creds = null;
    this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'qrcode' | 'open' | 'close'
    this.qr = null;
    this.qrBase64 = null;
    this.startedAt = null;
    this.isSaving = false;
    this.queuedSave = false;
    this.reconnectTimer = null;

    this.webhook = {
      url: process.env.WEBHOOK_GLOBAL_URL || '',
      enabled: Boolean(process.env.WEBHOOK_GLOBAL_URL),
      events: ['messages.upsert', 'connection.update'],
      headers: {}
    };

    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }

    this.loadConfigSync();
    this.loadWebhookSync();
  }

  loadConfigSync() {
    if (existsSync(this.configFile)) {
      try {
        const raw = JSON.parse(readFileSync(this.configFile, 'utf8'));
        if (raw.apikey && !this.apikey) {
          this.apikey = raw.apikey;
        }
      } catch (e) {}
    }
  }

  async saveConfig() {
    try {
      await writeFile(this.configFile, JSON.stringify({ apikey: this.apikey }, null, 2));
    } catch (e) {
      console.error(`[${this.name}] Erro ao salvar config:`, e.message);
    }
    upsertInstanceInDb(this.name, {
      status: this.status,
      apikey: this.apikey,
      ownerJid: this.creds?.me?.id,
      webhookUrl: this.webhook.url
    });
  }

  loadWebhookSync() {
    if (existsSync(this.webhookFile)) {
      try {
        const raw = JSON.parse(readFileSync(this.webhookFile, 'utf8'));
        this.webhook = { ...this.webhook, ...raw };
      } catch (e) {}
    }
  }

  async saveWebhook() {
    try {
      await writeFile(this.webhookFile, JSON.stringify(this.webhook, null, 2));
    } catch (e) {
      console.error(`[${this.name}] Erro ao salvar webhook:`, e.message);
    }
  }

  async setWebhook({ url, enabled = true, events, headers = {} }) {
    this.webhook = {
      url: String(url || '').trim(),
      enabled: Boolean(enabled),
      events: Array.isArray(events) ? events : (this.webhook.events || ['messages.upsert', 'connection.update']),
      headers: typeof headers === 'object' ? headers : {}
    };
    await this.saveWebhook();
    return this.getWebhook();
  }

  getWebhook() {
    return {
      instanceName: this.name,
      url: this.webhook.url,
      enabled: this.webhook.enabled,
      events: this.webhook.events,
      headers: this.webhook.headers
    };
  }

  async dispatchWebhook(event, data) {
    if (!this.webhook.enabled || !this.webhook.url) return;
    if (this.webhook.events && !this.webhook.events.includes(event)) return;

    const payload = {
      event,
      instanceName: this.name,
      data,
      timestamp: Math.floor(Date.now() / 1000)
    };

    const startTime = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      const res = await fetch(this.webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'standard-api-webhook/1.0',
          ...(this.webhook.headers || {})
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      logger.webhook(this.name, `Evento "${event}" enviado para ${this.webhook.url} (HTTP ${res.status} - ${duration}ms)`);
    } catch (err) {
      const duration = Date.now() - startTime;
      logger.warn(this.name, `Falha ao entregar webhook "${event}" em ${this.webhook.url} (${duration}ms): ${err.message}`);
    }
  }

  async saveCreds() {
    if (this.isSaving) {
      this.queuedSave = true;
      return;
    }
    this.isSaving = true;
    try {
      if (this.creds) {
        await writeFile(this.sessionFile, JSON.stringify(this.creds, null, 2));
      }
    } finally {
      this.isSaving = false;
      if (this.queuedSave) {
        this.queuedSave = false;
        this.saveCreds();
      }
    }
  }

  async init() {
    clearTimeout(this.reconnectTimer);
    if (this.client) {
      try { this.client.close(); } catch (e) {}
      this.client = null;
    }

    if (existsSync(this.sessionFile)) {
      try {
        const raw = await readFile(this.sessionFile, 'utf8');
        this.creds = JSON.parse(raw);
        normalizeCreds(this.creds);
      } catch (e) {
        console.error(`[${this.name}] Erro ao ler sessão existente:`, e.message);
        this.creds = initAuthCreds();
        this.creds = await signPreKeys(this.creds);
        await this.saveCreds();
      }
    } else {
      this.creds = initAuthCreds();
      this.creds = await signPreKeys(this.creds);
      await this.saveCreds();
    }

    this.status = 'connecting';
    this.startedAt = new Date();

    try {
      this.client = await connectWA({
        creds: this.creds,
        browser: ['Ubuntu', 'Chrome', '22.04.4'],
        pushName: `standard-api (${this.name})`
      });

      this.client.ev.on('creds.update', () => {
        this.saveCreds();
      });

      this.client.ev.on('connection.update', async (update) => {
        if (update.qr) {
          this.status = 'qrcode';
          this.qr = update.qr;
          try {
            this.qrBase64 = await QRCode.toDataURL(update.qr, { width: 350, margin: 2 });
            const terminalQR = await QRCode.toString(update.qr, { type: 'terminal', small: true });
            logger.auth(this.name, `Novo QR Code gerado. Escaneie no celular ou acesse /instance/qr/${this.name}:`);
            console.log(`\n${terminalQR}\n`);
          } catch (e) {
            logger.error(this.name, 'Erro ao gerar QR Code:', e);
          }
        }

        if (update.connection === 'open') {
          this.status = 'open';
          this.qr = null;
          this.qrBase64 = null;
          logger.instance(this.name, `Conexao estabelecida com sucesso como: ${this.creds.me?.id}`);
        }

        if (update.connection === 'close') {
          if (update.isLoggedOut) {
            logger.auth(this.name, 'Sessao desconectada/invalidada pelo WhatsApp. Gerando novo par de chaves e QR Code...');
            this.logout().then(() => this.init()).catch(() => {});
            return;
          }

          this.status = 'close';
          logger.warn(this.name, 'Conexao fechada. Tentando reconectar em 3s...');
          if (this.creds?.me) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this.init().catch(() => {}), 3000);
          }
        }

        if (update.connection === 'reconnecting') {
          this.status = 'connecting';
          logger.instance(this.name, 'Reconectando ao WhatsApp...');
        }

        this.dispatchWebhook('connection.update', {
          status: this.status,
          connection: update.connection,
          qr: update.qr,
          me: this.creds?.me || null
        });
      });

      // Webhook para novas mensagens recebidas
      this.client.ev.on('messages.upsert', (data) => {
        this.dispatchWebhook('messages.upsert', data);
        if (data?.messages) {
          for (const msg of data.messages) {
            const from = msg.key?.remoteJid || 'desconhecido';
            const textPreview = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
            const mediaType = Object.keys(msg.message || {})[0];
            const display = textPreview ? `"${textPreview}"` : `[${mediaType || 'mensagem'}]`;
            logger.incoming(this.name, `De ${from}: ${display}`);
            saveMessageToDb(this.name, msg);
          }
        }
      });

      // Webhook para recibos de entrega/leitura
      this.client.ev.on('receipts.update', (data) => {
        this.dispatchWebhook('receipts.update', data);
      });

      // Webhook para presenças (digitando, online)
      this.client.ev.on('presence.update', (data) => {
        this.dispatchWebhook('presence.update', data);
      });

    } catch (err) {
      console.error(`[${this.name}] Falha ao conectar:`, err.message);
      this.status = 'close';
      if (this.creds?.me) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.init().catch(() => {}), 3000);
      }
    }

    return this;
  }

  async sendMessage(number, text, options = {}) {
    if (this.status !== 'open') {
      console.log(`[${this.name}] Status atual é ${this.status}. Aguardando conexão...`);
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 250));
        if (this.status === 'open') break;
      }
    }

    if (this.status !== 'open' || !this.client) {
      throw new Error(`Instância "${this.name}" não está conectada ao WhatsApp (Status: ${this.status}). Acesse /instance/qr/${this.name} para conectar.`);
    }

    const cleanNumber = String(number).trim().replace(/[^0-9]/g, '');
    if (!cleanNumber) {
      throw new Error('Número de telefone inválido.');
    }
    logger.outgoing(this.name, `Enviando texto para ${cleanNumber}: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`);
    const result = await this.client.sendMessage(cleanNumber, { text }, options);
    logger.outgoing(this.name, `Texto entregue com sucesso! (ID: ${result.key.id})`);
    saveMessageToDb(this.name, result);
    return result;
  }

  async sendMedia(number, mediaOptions, options = {}) {
    if (this.status !== 'open') {
      logger.instance(this.name, `Status atual é ${this.status}. Aguardando conexao...`);
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 250));
        if (this.status === 'open') break;
      }
    }

    if (this.status !== 'open' || !this.client) {
      throw new Error(`Instância "${this.name}" não está conectada ao WhatsApp (Status: ${this.status}). Acesse /instance/qr/${this.name} para conectar.`);
    }

    const cleanNumber = String(number).trim().replace(/[^0-9]/g, '');
    if (!cleanNumber) {
      throw new Error('Número de telefone inválido.');
    }
    const mediaType = mediaOptions.type || 'midia';
    logger.outgoing(this.name, `Enviando ${mediaType} para ${cleanNumber}...`);
    const result = await this.client.sendMedia(cleanNumber, mediaOptions, options);
    logger.outgoing(this.name, `${mediaType} entregue com sucesso! (ID: ${result.key.id})`);
    saveMessageToDb(this.name, result);
    return result;
  }

  getStatus() {
    return {
      instanceName: this.name,
      status: this.status,
      apikey: this.apikey || null,
      connected: this.status === 'open',
      me: this.creds?.me || null,
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt.getTime()) / 1000) : 0,
      timestamp: new Date().toISOString()
    };
  }

  getQR() {
    return {
      instanceName: this.name,
      status: this.status,
      qr: this.qr,
      qrBase64: this.qrBase64
    };
  }

  async logout() {
    clearTimeout(this.reconnectTimer);
    if (this.client) {
      try { await this.client.logout(); } catch (e) {}
      this.client = null;
    }
    this.status = 'disconnected';
    this.qr = null;
    this.qrBase64 = null;
    this.creds = null;
    if (existsSync(this.sessionFile)) {
      try { await unlink(this.sessionFile); } catch (e) {}
    }
    const mediaConnFile = join(this.sessionDir, 'media_conn.json');
    if (existsSync(mediaConnFile)) {
      try { await unlink(mediaConnFile); } catch (e) {}
    }
  }

  async delete() {
    await this.logout();
    if (existsSync(this.sessionDir)) {
      try { await rm(this.sessionDir, { recursive: true, force: true }); } catch (e) {}
    }
  }
}

export class InstanceManager {
  constructor(options = {}) {
    this.baseDir = options.baseDir || './sessions';
    this.instances = new Map();

    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }

    this.migrateLegacySession();
  }

  migrateLegacySession() {
    const defaultDir = join(this.baseDir, 'default');
    const defaultFile = join(defaultDir, 'session.json');
    const oldSessionInDir = join(this.baseDir, 'session.json');
    const legacySessionInTmp = '/tmp/wa-api-session.json';

    if (!existsSync(defaultFile)) {
      if (existsSync(oldSessionInDir)) {
        mkdirSync(defaultDir, { recursive: true });
        copyFileSync(oldSessionInDir, defaultFile);
        try { unlink(oldSessionInDir); } catch (e) {}
        console.log('[manager] Sessão única migrada para a instância "default".');
      } else if (existsSync(legacySessionInTmp)) {
        mkdirSync(defaultDir, { recursive: true });
        copyFileSync(legacySessionInTmp, defaultFile);
        console.log('[manager] Sessão importada de /tmp para a instância "default".');
      }
    }
  }

  async initAll() {
    if (!existsSync(this.baseDir)) return;
    const entries = readdirSync(this.baseDir, { withFileTypes: true });
    
    const instanceDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    if (instanceDirs.length === 0) {
      instanceDirs.push('default');
    }

    for (const name of instanceDirs) {
      console.log(`[manager] Inicializando instância: "${name}"...`);
      const inst = new WhatsAppInstance(name, { baseDir: this.baseDir });
      this.instances.set(name, inst);
      await inst.init();
    }
  }

  async createInstance(name = 'default', options = {}) {
    const cleanName = String(name).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!cleanName) {
      throw new Error('Nome de instância inválido. Use apenas letras, números, hífens e underscores.');
    }

    if (this.instances.has(cleanName)) {
      const existing = this.instances.get(cleanName);
      if (options.apikey) {
        existing.apikey = options.apikey;
        await existing.saveConfig();
      }
      if (existing.status === 'open') {
        return { status: 'ALREADY_CONNECTED', instance: existing.getStatus() };
      }
      await existing.init();
      return { status: 'CONNECTING', instance: existing.getStatus() };
    }

    const instance = new WhatsAppInstance(cleanName, { baseDir: this.baseDir, apikey: options.apikey });
    this.instances.set(cleanName, instance);
    if (options.apikey) {
      await instance.saveConfig();
    }
    await instance.init();
    return { status: 'CREATED', instance: instance.getStatus() };
  }

  hasInstance(name) {
    const cleanName = String(name || '').trim().toLowerCase();
    return this.instances.has(cleanName) || existsSync(join(this.baseDir, cleanName));
  }

  getInstance(name = 'default') {
    const cleanName = String(name || 'default').trim().toLowerCase();
    let inst = this.instances.get(cleanName);
    if (!inst) {
      const dir = join(this.baseDir, cleanName);
      if (existsSync(dir)) {
        inst = new WhatsAppInstance(cleanName, { baseDir: this.baseDir });
        this.instances.set(cleanName, inst);
      } else {
        throw new Error(`Instância "${cleanName}" não encontrada. Crie-a primeiro em POST /instance/create.`);
      }
    }
    return inst;
  }

  listInstances() {
    return Array.from(this.instances.values()).map(inst => inst.getStatus());
  }

  async deleteInstance(name) {
    const cleanName = String(name).trim().toLowerCase();
    const inst = this.instances.get(cleanName);
    if (!inst) {
      throw new Error(`Instância "${cleanName}" não encontrada.`);
    }
    await inst.delete();
    this.instances.delete(cleanName);
    deleteInstanceFromDb(cleanName);
    return { status: 'DELETED', instanceName: cleanName };
  }
}
