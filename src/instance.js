import { connectWA } from './client.js';
import { initAuthCreds, signPreKeys, normalizeCreds } from './auth.js';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import QRCode from 'qrcode';

export class WhatsAppInstance {
  constructor(options = {}) {
    this.sessionDir = options.sessionDir || './sessions';
    this.sessionFile = join(this.sessionDir, 'session.json');
    this.client = null;
    this.creds = null;
    this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'qrcode' | 'open' | 'close'
    this.qr = null;
    this.qrBase64 = null;
    this.startedAt = null;
    this.isSaving = false;
    this.queuedSave = false;

    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }

    // Se houver uma sessão antiga em /tmp, importa automaticamente
    const legacySession = '/tmp/wa-api-session.json';
    if (!existsSync(this.sessionFile) && existsSync(legacySession)) {
      try {
        copyFileSync(legacySession, this.sessionFile);
        console.log('[instance] Sessão anterior importada com sucesso de /tmp/wa-api-session.json');
      } catch (e) {}
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
        console.error('[instance] Erro ao ler sessão existente:', e.message);
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

    this.client = await connectWA({
      creds: this.creds,
      browser: ['Ubuntu', 'Chrome', '22.04.4'],
      pushName: 'standard-api'
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
          console.error('[instance] Erro ao gerar QR base64:', e.message);
        }
      }

      if (update.connection === 'open') {
        this.status = 'open';
        this.qr = null;
        this.qrBase64 = null;
        console.log('[instance] Conexão estabelecida como', this.creds.me?.id);
      }

      if (update.connection === 'close') {
        this.status = 'close';
      }

      if (update.connection === 'reconnecting') {
        this.status = 'connecting';
      }
    });

    return this;
  }

  async sendMessage(number, text, options = {}) {
    if (this.status !== 'open' || !this.client) {
      throw new Error(`Instância não está conectada. Status atual: ${this.status}`);
    }
    const cleanNumber = String(number).trim().replace(/[^0-9]/g, '');
    if (!cleanNumber) {
      throw new Error('Número de telefone inválido.');
    }
    return await this.client.sendMessage(cleanNumber, { text }, options);
  }

  getStatus() {
    return {
      status: this.status,
      connected: this.status === 'open',
      me: this.creds?.me || null,
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt.getTime()) / 1000) : 0,
      timestamp: new Date().toISOString()
    };
  }

  getQR() {
    return {
      status: this.status,
      qr: this.qr,
      qrBase64: this.qrBase64
    };
  }

  async logout() {
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
}
