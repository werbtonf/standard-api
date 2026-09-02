import { connectWA } from '../core/transport/client.js';
import { initAuthCreds, signPreKeys, normalizeCreds } from '../core/pairing/auth.js';
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { logger } from '../utils/logger.js';
import { saveMessageToDb, upsertInstanceInDb, deleteInstanceFromDb, upsertContactInDb, listContactsFromDb } from '../database/postgres.js';

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

  async checkNumber(number) {
    if (this.status !== 'open' || !this.client) {
      throw new Error(`Instância "${this.name}" não está conectada ao WhatsApp.`);
    }
    const result = await this.client.checkNumber(number);
    if (result.exists && result.jid) {
      upsertContactInDb(this.name, {
        jid: result.jid
      });
    }
    return result;
  }

  async checkNumbers(numbers) {
    if (this.status !== 'open' || !this.client) {
      throw new Error(`Instância "${this.name}" não está conectada ao WhatsApp.`);
    }
    const results = await this.client.checkNumbers(numbers);
    for (const res of results) {
      if (res.exists && res.jid) {
        upsertContactInDb(this.name, {
          jid: res.jid
        });
      }
    }
    return results;
  }

  async getProfilePicture(number, type = 'image') {
    if (this.status !== 'open' || !this.client) {
      throw new Error(`Instância "${this.name}" não está conectada ao WhatsApp.`);
    }
    const check = await this.client.checkNumber(number);
    if (!check.exists) {
      return {
        instanceName: this.name,
        number,
        profilePictureUrl: null
      };
    }
    const canonicalJid = check.jid;
    const url = await this.client.profilePictureUrl(canonicalJid, type);
    if (url && canonicalJid) {
      upsertContactInDb(this.name, {
        jid: canonicalJid,
        profilePictureUrl: url
      });
    }
    return {
      instanceName: this.name,
      number,
      profilePictureUrl: url
    };
  }

  async getContactStatus(number) {
    if (this.status !== 'open' || !this.client) {
      throw new Error(`Instância "${this.name}" não está conectada ao WhatsApp.`);
    }
    const check = await this.client.checkNumber(number);
    if (!check.exists) {
      return {
        instanceName: this.name,
        jid: null,
        status: '',
        setAt: null
      };
    }
    const canonicalJid = check.jid;
    const result = await this.client.fetchStatus(canonicalJid);
    if (canonicalJid) {
      upsertContactInDb(this.name, {
        jid: canonicalJid,
        statusText: result.status || null
      });
    }
    return {
      instanceName: this.name,
      ...result,
      jid: canonicalJid
    };
  }

  async blockContact(number, action = 'block') {
    if (this.status !== 'open' || !this.client) {
      throw new Error(`Instância "${this.name}" não está conectada ao WhatsApp.`);
    }
    const result = await this.client.updateBlockStatus(number, action);
    logger.instance(this.name, `Contato ${number} foi ${action === 'unblock' ? 'desbloqueado' : 'bloqueado'}.`);
    return {
      instanceName: this.name,
      ...result
    };
  }

  async getBlocklist() {
    if (this.status !== 'open' || !this.client) {
      throw new Error(`Instância "${this.name}" não está conectada ao WhatsApp.`);
    }
    const list = await this.client.fetchBlocklist();
    return {
      instanceName: this.name,
      total: list.length,
      blocklist: list
    };
  }

  async updateProfileStatus(statusText) {
    if (this.status !== 'open' || !this.client) {
      throw new Error(`Instância "${this.name}" não está conectada ao WhatsApp.`);
    }
    const result = await this.client.updateProfileStatus(statusText);
    logger.instance(this.name, `Recado do perfil atualizado para: "${statusText}"`);
    return {
      instanceName: this.name,
      ...result
    };
  }

  async listContacts(limit = 50, offset = 0) {
    return await listContactsFromDb(this.name, limit, offset);
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

