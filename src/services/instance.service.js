import { connectWA } from '../core/transport/client.js';
import { initAuthCreds, signPreKeys, normalizeCreds } from '../core/pairing/auth.js';
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { readFile, writeFile, unlink, rm, rename } from 'node:fs/promises';
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
    this.reconnectAttempts = 0;

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
      const response = await this._deliverWebhook(payload);
      const duration = Date.now() - startTime;
      if (response.ok) {
        logger.webhook(this.name, `Evento "${event}" enviado para ${this.webhook.url} (HTTP ${response.status} - ${duration}ms)`);
      } else {
        logger.warn(this.name, `Falha ao entregar webhook "${event}" em ${this.webhook.url} (HTTP ${response.status} - ${duration}ms)`);
      }
    } catch (err) {
      const duration = Date.now() - startTime;
      logger.warn(this.name, `Falha ao entregar webhook "${event}" em ${this.webhook.url} (${duration}ms): ${err.message}`);
    }
  }

  async _deliverWebhook(payload, attempt = 0) {
    const maxAttempts = 3;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

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
      return res;
    } catch (err) {
      if (attempt < maxAttempts - 1) {
        const delay = 500 * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
        return this._deliverWebhook(payload, attempt + 1);
      }
      throw err;
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
        const tmpFile = `${this.sessionFile}.tmp`;
        await writeFile(tmpFile, JSON.stringify(this.creds, null, 2));
        await rename(tmpFile, this.sessionFile);
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
        try {
          const corruptFile = `${this.sessionFile}.corrupt-${Date.now()}`;
          await rename(this.sessionFile, corruptFile);
          console.error(`[${this.name}] Sessão corrompida preservada em ${corruptFile}. Gerando novo par de chaves.`);
        } catch (e2) {
          console.error(`[${this.name}] Não foi possível preservar a sessão corrompida:`, e2.message);
        }
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
          this.reconnectAttempts = 0;
          logger.instance(this.name, `Conexao estabelecida com sucesso como: ${this.creds.me?.id}`);
        }

        if (update.connection === 'close') {
          if (update.isLoggedOut) {
            logger.auth(this.name, 'Sessao desconectada/invalidada pelo WhatsApp. Gerando novo par de chaves e QR Code...');
            this.logout().then(() => this.init()).catch(() => {});
            return;
          }

          this.status = 'close';
          if (this.creds?.me) {
            this.reconnectAttempts += 1;
            if (this.reconnectAttempts > 10) {
              logger.warn(this.name, `${this.reconnectAttempts - 1} reconexoes consecutivas sem sucesso. Retry automatico interrompido — chame POST /instance/connect manualmente.`);
              return;
            }
            const delay = Math.min(3000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
            logger.warn(this.name, `Conexao fechada. Reconectando em ${Math.round(delay / 1000)}s (tentativa ${this.reconnectAttempts}/10)...`);
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this.init().catch(() => {}), delay);
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
        const messages = Array.isArray(data?.messages) ? data.messages : (Array.isArray(data) ? data : [data]);
        for (const msg of messages) {
          this.dispatchWebhook('messages.upsert', msg);
          const from = msg.key?.remoteJid || 'desconhecido';
          const textPreview = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
          const mediaType = Object.keys(msg.message || {})[0];
          const display = textPreview ? `"${textPreview}"` : `[${mediaType || 'mensagem'}]`;
          logger.incoming(this.name, `De ${from}: ${display}`);
          saveMessageToDb(this.name, msg);
        }
      });

      // Webhook para atualizações de status de mensagem (enviada, entregue, lida)
      this.client.ev.on('messages.update', (data) => {
        const updates = Array.isArray(data) ? data : [data];
        for (const upd of updates) {
          this.dispatchWebhook('messages.update', upd);
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

  async sendReaction(remoteJid, messageId, emoji, fromMe = false) {
    if (this.status !== 'open' || !this.client) {
      throw new Error(`Instância "${this.name}" não está conectada ao WhatsApp.`);
    }
    const cleanJid = String(remoteJid).trim().includes('@') ? remoteJid : `${remoteJid}@s.whatsapp.net`;
    const reactionPayload = {
      react: {
        key: {
          remoteJid: cleanJid,
          fromMe: Boolean(fromMe),
          id: messageId
        },
        text: emoji || '',
        senderTimestampMs: Date.now()
      }
    };
    const result = await this.client.sendMessage(cleanJid, reactionPayload);
    saveMessageToDb(this.name, result);
    return result;
  }

  async deleteMessage(remoteJid, messageId, fromMe = true) {
    if (this.status !== 'open' || !this.client) {
      throw new Error(`Instância "${this.name}" não está conectada ao WhatsApp.`);
    }
    const cleanJid = String(remoteJid).trim().includes('@') ? remoteJid : `${remoteJid}@s.whatsapp.net`;
    const protocolPayload = {
      protocolMessage: {
        key: {
          remoteJid: cleanJid,
          fromMe: Boolean(fromMe),
          id: messageId
        },
        type: 0 // REVOKE
      }
    };
    const result = await this.client.sendMessage(cleanJid, protocolPayload);
    saveMessageToDb(this.name, result);
    return result;
  }

  async sendPresence(presenceType, number = null) {
    if (this.status !== 'open' || !this.client) {
      throw new Error(`Instância "${this.name}" não está conectada ao WhatsApp.`);
    }
    const targetJid = number ? (String(number).includes('@') ? number : `${number.replace(/[^0-9]/g, '')}@s.whatsapp.net`) : null;
    await this.client.sendPresence(presenceType, targetJid);
    return { status: 'SUCCESS', instanceName: this.name, presence: presenceType, target: targetJid || 'all' };
  }

  async markMessageAsRead(readMessages = []) {
    if (this.status !== 'open' || !this.client) {
      throw new Error(`Instância "${this.name}" não está conectada ao WhatsApp.`);
    }
    const list = Array.isArray(readMessages) ? readMessages : [readMessages];
    for (const item of list) {
      const jid = item.remoteJid || item.jid || item.from;
      const id = item.id || item.messageId;
      const participant = item.participant || null;
      if (jid && id) {
        await this.client.sendReceipt(jid, participant, id, 'read');
      }
    }
    return { status: 'SUCCESS', instanceName: this.name, markedCount: list.length };
  }

  async restart() {
    if (this.client) {
      try { this.client.close(); } catch (e) {}
    }
    this.status = 'connecting';
    setTimeout(() => {
      this.init().catch(err => console.error(`[${this.name}] Erro ao reiniciar:`, err.message));
    }, 1000);
    return { status: 'RESTARTING', instanceName: this.name };
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

