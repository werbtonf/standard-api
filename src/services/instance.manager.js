import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { WhatsAppInstance } from './instance.service.js';
import { deleteInstanceFromDb } from '../database/postgres.js';

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
      console.log('[manager] Nenhuma instância encontrada; nada para auto-inicializar.');
      return;
    }

    for (const name of instanceDirs) {
      console.log(`[manager] Inicializando instância: "${name}"...`);
      const sessionFile = join(this.baseDir, name, 'session.json');
      if (!existsSync(sessionFile)) {
        console.log(`[manager] Instância "${name}" sem sessão; pulando auto-init.`);
        continue;
      }
      try {
        const creds = JSON.parse(readFileSync(sessionFile, 'utf8'));
        if (!creds?.me?.id || !creds?.signedIdentityKey) {
          console.log(`[manager] Instância "${name}" sem conta validada; pulando auto-init (pareie manualmente via /instance/connect).`);
          continue;
        }
      } catch (e) {
        console.warn(`[manager] Sessão corrompida em "${name}"; pulando auto-init.`);
        continue;
      }
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
    let inst = this.instances.get(cleanName);
    if (!inst) {
      const dir = join(this.baseDir, cleanName);
      if (!existsSync(dir)) {
        throw new Error(`Instância "${cleanName}" não encontrada.`);
      }
      inst = new WhatsAppInstance(cleanName, { baseDir: this.baseDir });
    }
    await inst.delete();
    this.instances.delete(cleanName);
    deleteInstanceFromDb(cleanName);
    return { status: 'DELETED', instanceName: cleanName };
  }
}
