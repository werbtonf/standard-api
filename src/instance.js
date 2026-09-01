import { connectWA } from './client.js';
import { initAuthCreds, signPreKeys, normalizeCreds } from './auth.js';
import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import QRCode from 'qrcode';

export class WhatsAppInstance {
  constructor(name, options = {}) {
    this.name = name;
    this.baseDir = options.baseDir || './sessions';
    this.sessionDir = join(this.baseDir, this.name);
    this.sessionFile = join(this.sessionDir, 'session.json');
    this.client = null;
    this.creds = null;
    this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'qrcode' | 'open' | 'close'
    this.qr = null;
    this.qrBase64 = null;
    this.startedAt = null;
    this.isSaving = false;
    this.queuedSave = false;
    this.reconnectTimer = null;

    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
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
          } catch (e) {
            console.error(`[${this.name}] Erro ao gerar QR base64:`, e.message);
          }
        }

        if (update.connection === 'open') {
          this.status = 'open';
          this.qr = null;
          this.qrBase64 = null;
          console.log(`[${this.name}] 🟢 Conexão estabelecida como`, this.creds.me?.id);
        }

        if (update.connection === 'close') {
          this.status = 'close';
          console.log(`[${this.name}] 🔴 Conexão fechada. Tentando reconectar em 3s...`);
          if (this.creds?.me) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this.init().catch(() => {}), 3000);
          }
        }

        if (update.connection === 'reconnecting') {
          this.status = 'connecting';
        }
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
    return await this.client.sendMessage(cleanNumber, { text }, options);
  }

  getStatus() {
    return {
      instanceName: this.name,
      status: this.status,
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
      try { this.client.close(); } catch (e) {}
    }
    this.status = 'disconnected';
    this.qr = null;
    this.qrBase64 = null;
    this.creds = null;
    if (existsSync(this.sessionFile)) {
      try { await unlink(this.sessionFile); } catch (e) {}
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

    // Migração automática de sessão anterior (seja de ./sessions/session.json ou /tmp)
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
    
    // Se não existir nenhuma instância, inicializa a instância "default"
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

  async createInstance(name = 'default') {
    const cleanName = String(name).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!cleanName) {
      throw new Error('Nome de instância inválido. Use apenas letras, números, hífens e underscores.');
    }

    if (this.instances.has(cleanName)) {
      const existing = this.instances.get(cleanName);
      if (existing.status === 'open') {
        return { status: 'ALREADY_CONNECTED', instance: existing.getStatus() };
      }
      await existing.init();
      return { status: 'CONNECTING', instance: existing.getStatus() };
    }

    const instance = new WhatsAppInstance(cleanName, { baseDir: this.baseDir });
    this.instances.set(cleanName, instance);
    await instance.init();
    return { status: 'CREATED', instance: instance.getStatus() };
  }

  getInstance(name = 'default') {
    const cleanName = String(name || 'default').trim().toLowerCase();
    const inst = this.instances.get(cleanName);
    if (!inst) {
      throw new Error(`Instância "${cleanName}" não encontrada. Crie-a primeiro em POST /instance/create.`);
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
    return { status: 'DELETED', instanceName: cleanName };
  }
}
