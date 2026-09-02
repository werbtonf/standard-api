import libsignal from 'libsignal';
import { Curve, randomBytes } from './crypto.js';
import { KEY_BUNDLE_TYPE } from '../pairing/auth.js';
import { logger } from '../../utils/logger.js';
import { formatPhoneNumber } from '../../utils/phone.js';
export { formatPhoneNumber };

export const generateSignalPubKey = (pubKey) => {
  if (!pubKey) return pubKey;
  const buf = Buffer.isBuffer(pubKey) ? pubKey : Buffer.from(pubKey);
  return buf.length === 33 ? buf : Buffer.concat([KEY_BUNDLE_TYPE, buf]);
};

export function jidDecode(jid) {
  if (typeof jid !== 'string' || !jid.includes('@')) return null;
  const sepIdx = jid.indexOf('@');
  if (sepIdx < 0) return null;
  const userCombined = jid.slice(0, sepIdx);
  const server = jid.slice(sepIdx + 1);

  const [userAgent, deviceStr] = userCombined.split(':');
  const [user, agent] = userAgent.split('_');
  const device = deviceStr ? +deviceStr : undefined;

  let domainType = 0;
  if (server === 'lid') domainType = 1;
  else if (server === 'hosted') domainType = 128;
  else if (server === 'hosted.lid') domainType = 129;
  else if (agent) domainType = parseInt(agent);

  return {
    server,
    user: user || '',
    domainType,
    device
  };
}

export function jidToSignalProtocolAddress(jid) {
  const decoded = jidDecode(jid);
  if (!decoded || !decoded.user) {
    const [user] = String(jid).split('@');
    return new libsignal.ProtocolAddress(user, 0);
  }
  const user = decoded.domainType > 0 ? `${decoded.user}_${decoded.domainType}` : decoded.user;
  return new libsignal.ProtocolAddress(user, decoded.device || 0);
}

/** Cache em memória para resolução USync (evita rate-limit do WhatsApp) */
const usyncCache = new Map();

/**
 * Cria o repositório Signal com persistência nas credenciais do cliente.
 */
export function makeSignalRepository(creds, ev) {
  if (!creds.sessions) creds.sessions = {};
  if (!creds.identities) creds.identities = {};
  if (!creds.preKeys) creds.preKeys = {};

  const storage = {
    async loadSession(id) {
      const sess = creds.sessions[id];
      if (sess) {
        try {
          const parsed = typeof sess === 'string' ? JSON.parse(sess) : sess;
          return libsignal.SessionRecord.deserialize(parsed);
        } catch (e) {
          return null;
        }
      }
      return null;
    },

    async storeSession(id, record) {
      creds.sessions[id] = JSON.stringify(record.serialize());
      if (ev) ev.emit('creds.update', { sessions: creds.sessions });
    },

    async isTrustedIdentity() {
      return true; // Trust on First Use (padrão WhatsApp Web)
    },

    async loadIdentityKey(id) {
      const key = creds.identities[id];
      if (!key) return undefined;
      return Buffer.isBuffer(key) ? key : Buffer.from(key, 'base64');
    },

    async saveIdentity(id, identityKey) {
      const keyBuf = Buffer.isBuffer(identityKey) ? identityKey : Buffer.from(identityKey);
      creds.identities[id] = keyBuf.toString('base64');
      if (ev) ev.emit('creds.update', { identities: creds.identities });
      return true;
    },

    async loadPreKey(id) {
      const key = creds.preKeys[id];
      if (key) {
        return {
          pubKey: Buffer.isBuffer(key.public) ? key.public : Buffer.from(key.public, 'base64'),
          privKey: Buffer.isBuffer(key.private) ? key.private : Buffer.from(key.private, 'base64')
        };
      }
      return undefined;
    },

    async storePreKey(id, keyPair) {
      creds.preKeys[id] = {
        public: Buffer.from(keyPair.pubKey).toString('base64'),
        private: Buffer.from(keyPair.privKey).toString('base64')
      };
      if (ev) ev.emit('creds.update', { preKeys: creds.preKeys });
    },

    async removePreKey(id) {
      delete creds.preKeys[id];
      if (ev) ev.emit('creds.update', { preKeys: creds.preKeys });
    },

    async loadSignedPreKey() {
      const key = creds.signedPreKey;
      return {
        pubKey: generateSignalPubKey(key.keyPair.public),
        privKey: Buffer.from(key.keyPair.private),
        signature: Buffer.from(key.signature)
      };
    },

    async getOurRegistrationId() {
      return creds.registrationId;
    },

    async getOurIdentity() {
      return {
        pubKey: generateSignalPubKey(creds.signedIdentityKey.public),
        privKey: Buffer.from(creds.signedIdentityKey.private)
      };
    }
  };

  const hasSession = async (jid) => {
    const addr = jidToSignalProtocolAddress(jid);
    const session = await storage.loadSession(addr.toString());
    return !!(session && session.haveOpenSession());
  };

  const injectSession = async (jid, sessionBundle) => {
    const addr = jidToSignalProtocolAddress(jid);
    const builder = new libsignal.SessionBuilder(storage, addr);
    await builder.initOutgoing(sessionBundle);
  };

  const encryptMessage = async ({ jid, data }) => {
    const addr = jidToSignalProtocolAddress(jid);
    const cipher = new libsignal.SessionCipher(storage, addr);
    const enc = await cipher.encrypt(data);
    const type = enc.type === 3 ? 'pkmsg' : 'msg';
    return {
      type,
      ciphertext: Buffer.from(enc.body, 'binary')
    };
  };

  const decryptMessage = async ({ jid, type, ciphertext }) => {
    const addr = jidToSignalProtocolAddress(jid);
    const cipher = new libsignal.SessionCipher(storage, addr);
    let plaintext;
    if (type === 'pkmsg') {
      plaintext = await cipher.decryptPreKeyWhisperMessage(ciphertext);
    } else {
      plaintext = await cipher.decryptWhisperMessage(ciphertext);
    }
    return Buffer.from(plaintext);
  };

  const clearSessions = (jid) => {
    const decoded = jidDecode(jid);
    const uid = decoded?.user || String(jid).split('@')[0];
    if (!uid) return;
    let removed = 0;
    for (const key of Object.keys(creds.sessions || {})) {
      const keyUserId = String(key).split('@')[0].split('.')[0];
      if (keyUserId === uid || keyUserId.startsWith(`${uid}_`)) {
        delete creds.sessions[key];
        removed++;
      }
    }
    if (removed > 0) {
      if (ev) ev.emit('creds.update', { sessions: creds.sessions });
      console.log(`[signal] sessoes resetadas para ${uid} (${removed})`);
    }
  };

  return {
    storage,
    hasSession,
    injectSession,
    encryptMessage,
    decryptMessage,
    clearSessions
  };
}

/**
 * Consulta o USync com cache de 10 minutos para obter o JID canônico e dispositivos.
 */
export async function usyncUser(query, input) {
  const formattedPhone = formatPhoneNumber(input);
  const cacheKey = formattedPhone;

  const cached = usyncCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) {
    return cached.data;
  }

  const phoneWithPlus = '+' + formattedPhone;

  try {
    const res = await query({
      tag: 'iq',
      attrs: { to: '@s.whatsapp.net', type: 'get', xmlns: 'usync' },
      content: [
        {
          tag: 'usync',
          attrs: { sid: generateUSyncSid(), mode: 'query', last: 'true', index: '0', context: 'interactive' },
          content: [
            {
              tag: 'query',
              attrs: {},
              content: [
                { tag: 'contact', attrs: {} },
                { tag: 'devices', attrs: { version: '2' } }
              ]
            },
            {
              tag: 'list',
              attrs: {},
              content: [
                { tag: 'user', attrs: {}, content: [{ tag: 'contact', attrs: {}, content: phoneWithPlus }] }
              ]
            }
          ]
        }
      ]
    }, 5000);

    const usyncNode = (res.content || []).find(c => c && c.tag === 'usync');
    const listNode = usyncNode ? (usyncNode.content || []).find(c => c && c.tag === 'list') : null;
    const userNode = listNode ? (listNode.content || []).find(c => c && c.tag === 'user') : null;

    if (userNode && userNode.attrs && userNode.attrs.jid) {
      const canonicalJid = userNode.attrs.jid;
      const { user, server } = jidDecode(canonicalJid) || { user: canonicalJid.split('@')[0], server: 's.whatsapp.net' };
      const devicesNode = (userNode.content || []).find(c => c && c.tag === 'devices');
      const deviceListNode = devicesNode ? (devicesNode.content || []).find(c => c && c.tag === 'device-list') : null;
      
      const devices = [];
      let foundZero = false;

      if (deviceListNode && Array.isArray(deviceListNode.content)) {
        for (const dev of deviceListNode.content) {
          if (dev && dev.tag === 'device' && dev.attrs && dev.attrs.id !== undefined) {
            const id = +dev.attrs.id;
            const keyIndex = dev.attrs['key-index'];
            if (id === 0) foundZero = true;
            if (id === 0 || keyIndex) {
              const jid = id === 0 ? canonicalJid : `${user}:${id}@${server}`;
              devices.push({ id, jid, keyIndex });
            }
          }
        }
      }

      if (!foundZero) {
        devices.unshift({ id: 0, jid: canonicalJid });
      }

      const result = { jid: canonicalJid, devices };
      usyncCache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    }
  } catch (err) {
    console.warn('[usync] Falha ao consultar usync:', err.message);
  }

  // Se o número tem 12 ou 13 dígitos no Brasil (ex: 5599991081780) e o USync falhou:
  // no Brasil (DDD 99), se 13 dígitos (55 + 99 + 9 + 8 dígitos), o formato sem o 9º dígito é 559991081780
  let fallbackJid = `${formattedPhone}@s.whatsapp.net`;
  if (formattedPhone.startsWith('55') && formattedPhone.length === 13) {
    const ddd = formattedPhone.slice(2, 4);
    const ninthDigit = formattedPhone[4];
    if (ninthDigit === '9') {
      const eightDigitJid = `55${ddd}${formattedPhone.slice(5)}@s.whatsapp.net`;
      fallbackJid = eightDigitJid;
    }
  }

  const result = { jid: fallbackJid, devices: [{ id: 0, jid: fallbackJid }] };
  return result;
}

let usyncSidCounter = 0;
function generateUSyncSid() {
  return `${Date.now()}_${++usyncSidCounter}`;
}

/* ------------------------------------------------------------------ */
/* LID <-> PN mapping (WhatsApp phone-number vs stable-64-bit LID)     */
/* ------------------------------------------------------------------ */

const lidMapCache = {};

export function rememberLidMapping(lidJid, pnJid) {
  if (!lidJid || !lidJid.includes('@lid') || !pnJid) return;
  if (lidMapCache[lidJid] === pnJid) return;
  lidMapCache[lidJid] = pnJid;
  console.log(`[lid] mapping armazenado: ${lidJid} -> ${pnJid}`);
}

/**
 * Busca o mapeamento LID->PN completo (usync context=lid, como o Baileys).
 * Custo alto; use resolveLidToPn para consultas individuais.
 */
export async function fetchLidToPnMap(query) {
  try {
    const res = await query({
      tag: 'iq',
      attrs: { to: '@s.whatsapp.net', type: 'get', xmlns: 'usync' },
      content: [
        {
          tag: 'usync',
          attrs: { sid: generateUSyncSid(), mode: 'query', last: 'true', index: '0', context: 'lid' },
          content: [
            { tag: 'query', attrs: {}, content: [{ tag: 'contact', attrs: {} }] },
            {
              tag: 'list',
              attrs: {},
              content: [
                { tag: 'user', attrs: {}, content: [{ tag: 'contact', attrs: {}, content: Buffer.from('*') }] }
              ]
            }
          ]
        }
      ]
    }, 5000);

    const usyncNode = (res.content || []).find(c => c && c.tag === 'usync');
    const listNode = usyncNode ? (usyncNode.content || []).find(c => c && c.tag === 'list') : null;
    const userNodes = listNode ? (listNode.content || []).filter(c => c && c.tag === 'user') : [];

    const map = {};
    for (const u of userNodes) {
      if (u.attrs?.jid && u.attrs?.lid) {
        map[u.attrs.lid] = u.attrs.jid;
      }
    }
    Object.assign(lidMapCache, map);
    console.log(`[lid] mapeamento usync: ${Object.keys(map).length} entrada(s)`);
    return map;
  } catch (e) {
    console.warn('[lid] falha ao buscar mapeamento usync:', e.message);
    return {};
  }
}

export async function resolveLidToPn(query, lidJid) {
  if (!lidJid || !lidJid.includes('@lid')) return null;
  if (lidMapCache[lidJid]) return lidMapCache[lidJid];
  const map = await fetchLidToPnMap(query);
  return map[lidJid] || null;
}

export function cachedLidForPn(pnJid) {
  if (!pnJid) return null;
  const pnUser = String(pnJid).split('@')[0].split(':')[0];
  for (const [lid, pn] of Object.entries(lidMapCache)) {
    if (pn && String(pn).split('@')[0].split(':')[0] === pnUser) return lid;
  }
  return null;
}

/**
 * Busca pré-chaves públicas dos destinatários no servidor do WhatsApp em um único IQ em lote.
 */
export async function fetchPreKeys(query, devicesList, repository, timeoutMs = 5000) {
  const list = Array.isArray(devicesList) ? devicesList : [devicesList];
  const itemsToFetch = [];

  for (const item of list) {
    const jid = typeof item === 'string' ? item : item.jid;
    const keyIndex = typeof item === 'object' ? item.keyIndex : undefined;
    const hasSess = await repository.hasSession(jid);
    if (!hasSess) {
      itemsToFetch.push({ jid, keyIndex });
    }
  }

  if (itemsToFetch.length === 0) return;

  console.log(`[fetchPreKeys] Buscando pre-chaves para ${itemsToFetch.length} dispositivo(s): ${itemsToFetch.map(i => i.jid).join(', ')}`);

  const S_WHATSAPP_NET = '@s.whatsapp.net';
  const iq = {
    tag: 'iq',
    attrs: {
      to: S_WHATSAPP_NET,
      type: 'get',
      xmlns: 'encrypt'
    },
    content: [
      {
        tag: 'key',
        attrs: {},
        content: itemsToFetch.map(({ jid, keyIndex }) => {
          const node = { tag: 'user', attrs: { jid, reason: 'identity' } };
          if (keyIndex) node.attrs['key-index'] = String(keyIndex);
          return node;
        })
      }
    ]
  };

  const readBigEndian = (buf) => {
    if (!buf) return 0;
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    let val = 0;
    for (let i = 0; i < b.length; i++) {
      val = (val << 8) | b[i];
    }
    return val;
  };

  try {
    const result = await query(iq, timeoutMs);
    const listNode = (result.content || []).find(c => c && c.tag === 'list');
    if (!listNode) {
      console.log('[fetchPreKeys] Resposta sem nó list, retornando.');
      return;
    }

    const userNodes = (listNode.content || []).filter(c => c && c.tag === 'user');
    console.log(`[fetchPreKeys] Recebidas pre-chaves de ${userNodes.length} dispositivo(s).`);
    for (const userNode of userNodes) {
      const jid = userNode.attrs.jid;
      if (!jid) continue;

      const registrationNode = (userNode.content || []).find(c => c && c.tag === 'registration');
      const identityNode = (userNode.content || []).find(c => c && c.tag === 'identity');
      const skeyNode = (userNode.content || []).find(c => c && c.tag === 'skey');
      const preKeyNode = (userNode.content || []).find(c => c && c.tag === 'key');

      if (!identityNode || !skeyNode) continue;

      const skeyIdNode = (skeyNode.content || []).find(c => c && c.tag === 'id');
      const skeyValNode = (skeyNode.content || []).find(c => c && c.tag === 'value');
      const skeySigNode = (skeyNode.content || []).find(c => c && c.tag === 'signature');

      const sessionBundle = {
        registrationId: registrationNode ? readBigEndian(registrationNode.content) : 0,
        identityKey: generateSignalPubKey(identityNode.content),
        signedPreKey: {
          keyId: skeyIdNode ? readBigEndian(skeyIdNode.content) : 1,
          publicKey: generateSignalPubKey(skeyValNode?.content),
          signature: skeySigNode?.content
        }
      };

      if (preKeyNode) {
        const preKeyIdNode = (preKeyNode.content || []).find(c => c && c.tag === 'id');
        const preKeyValNode = (preKeyNode.content || []).find(c => c && c.tag === 'value');
        if (preKeyValNode) {
          sessionBundle.preKey = {
            keyId: preKeyIdNode ? readBigEndian(preKeyIdNode.content) : 1,
            publicKey: generateSignalPubKey(preKeyValNode.content)
          };
        }
      }

      await repository.injectSession(jid, sessionBundle);
      console.log(`[fetchPreKeys] Sessão injetada para ${jid}`);
    }
  } catch (err) {
    console.warn(`[fetchPreKeys] Falha na busca de pre-chaves: ${err.message}`);
  }
}

const usyncContactCache = new Map(); // phone -> { exists, jid, expiresAt }

/**
 * Verifica se múltiplos números de telefone estão cadastrados no WhatsApp em uma única consulta USync em lote.
 */
export async function checkWhatsAppNumbers(query, rawNumbers) {
  const list = Array.isArray(rawNumbers) ? rawNumbers : [rawNumbers];
  const queryItems = [];
  const now = Date.now();

  for (const raw of list) {
    const formatted = formatPhoneNumber(raw);
    if (!formatted) continue;

    const phones = [formatted];
    if (formatted.startsWith('55')) {
      if (formatted.length === 13 && formatted[4] === '9') {
        phones.push(`55${formatted.slice(2, 4)}${formatted.slice(5)}`);
      } else if (formatted.length === 12) {
        phones.push(`55${formatted.slice(2, 4)}9${formatted.slice(4)}`);
      }
    }

    queryItems.push({
      original: String(raw).trim(),
      primary: formatted,
      variants: phones
    });
  }

  if (queryItems.length === 0) return [];

  const phoneResults = new Map(); // phone -> { exists, jid }
  const phonesToFetch = [];

  for (const item of queryItems) {
    let foundInCache = false;
    for (const p of item.variants) {
      const cached = usyncContactCache.get(p);
      if (cached && cached.expiresAt > now) {
        phoneResults.set(p, { exists: cached.exists, jid: cached.jid });
        foundInCache = true;
        break;
      }
    }
    if (!foundInCache) {
      if (!phonesToFetch.includes(item.primary)) {
        phonesToFetch.push(item.primary);
      }
    }
  }

  // Se há números a buscar na rede do WhatsApp
  if (phonesToFetch.length > 0) {
    try {
      const res = await query({
        tag: 'iq',
        attrs: { to: '@s.whatsapp.net', type: 'get', xmlns: 'usync' },
        content: [
          {
            tag: 'usync',
            attrs: { sid: generateUSyncSid(), mode: 'query', last: 'true', index: '0', context: 'interactive' },
            content: [
              {
                tag: 'query',
                attrs: {},
                content: [
                  { tag: 'contact', attrs: {} }
                ]
              },
              {
                tag: 'list',
                attrs: {},
                content: phonesToFetch.map(p => ({
                  tag: 'user',
                  attrs: {},
                  content: [{ tag: 'contact', attrs: {}, content: '+' + p }]
                }))
              }
            ]
          }
        ]
      }, 10000);

      const usyncNode = (res.content || []).find(c => c && c.tag === 'usync');
      const listNode = usyncNode ? (usyncNode.content || []).find(c => c && c.tag === 'list') : null;
      const userNodes = listNode ? (listNode.content || []).filter(c => c && c.tag === 'user') : [];

      for (const userNode of userNodes) {
        console.log('[USync userNode]', JSON.stringify(userNode));
        const jid = userNode.attrs?.jid || null;
        const jidUser = jid ? jid.split('@')[0].split(':')[0] : null;

        const contactNodes = (userNode.content || []).filter(c => c && c.tag === 'contact');
        let contactExists = false;
        let matchedPhone = null;

        for (const contactNode of contactNodes) {
          const contactExists = contactNode.attrs?.type === 'in';
          const rawContent = contactNode.content;
          let phoneText = null;
          if (rawContent) {
            if (Buffer.isBuffer(rawContent)) {
              phoneText = rawContent.toString('utf-8');
            } else if (rawContent instanceof Uint8Array) {
              phoneText = Buffer.from(rawContent).toString('utf-8');
            } else if (typeof rawContent === 'object' && Array.isArray(rawContent.data)) {
              phoneText = Buffer.from(rawContent.data).toString('utf-8');
            } else {
              phoneText = String(rawContent);
            }
          }

          const phoneClean = phoneText ? phoneText.replace(/[^0-9]/g, '') : null;
          if (phoneClean) {
            matchedPhone = phoneClean;
            const entry = {
              exists: contactExists,
              jid: contactExists ? (jid || `${phoneClean}@s.whatsapp.net`) : null
            };
            phoneResults.set(phoneClean, entry);
            usyncContactCache.set(phoneClean, { ...entry, expiresAt: now + (60 * 60 * 1000) });
          }
        }

        if (jidUser && !matchedPhone) {
          const entry = {
            exists: contactExists,
            jid: contactExists ? jid : null
          };
          phoneResults.set(jidUser, entry);
          usyncContactCache.set(jidUser, { ...entry, expiresAt: now + (60 * 60 * 1000) });
        }
      }
    } catch (err) {
      logger.warn('contact', `Erro ao verificar lote de números USync: ${err.message}`);
    }
  }

  // Mapeia de volta para cada entrada original
  const results = [];
  for (const item of queryItems) {
    let matched = null;
    for (const p of item.variants) {
      if (phoneResults.has(p)) {
        const res = phoneResults.get(p);
        matched = {
          exists: res.exists,
          jid: res.jid,
          number: item.original
        };
        if (res.exists) break;
      }
    }

    if (!matched) {
      results.push({
        exists: false,
        jid: null,
        number: item.original
      });
    } else {
      results.push(matched);
    }
  }

  return results;
}

export async function checkWhatsAppNumber(query, number) {
  const results = await checkWhatsAppNumbers(query, [number]);
  return results[0] || { exists: false, jid: null, number: String(number) };
}

/**
 * Obtém a URL da foto de perfil de um contato ou grupo no WhatsApp CDN.
 */
export async function fetchProfilePictureUrl(query, jidOrNumber, type = 'image') {
  let targetJid = String(jidOrNumber).trim();

  // Se não é grupo (@g.us) e não tem @, resolve o JID canônico
  if (!targetJid.includes('@g.us')) {
    if (!targetJid.includes('@')) {
      const check = await checkWhatsAppNumber(query, targetJid);
      if (!check.exists) {
        return null;
      }
      targetJid = check.jid || `${formatPhoneNumber(targetJid)}@s.whatsapp.net`;
    }
  }

  try {
    const res = await query({
      tag: 'iq',
      attrs: {
        target: targetJid,
        to: '@s.whatsapp.net',
        type: 'get',
        xmlns: 'w:profile:picture'
      },
      content: [
        {
          tag: 'picture',
          attrs: { type: type === 'preview' ? 'preview' : 'image', query: 'url' }
        }
      ]
    }, 10000);

    const pictureNode = (res.content || []).find(c => c && c.tag === 'picture');
    return pictureNode?.attrs?.url || null;
  } catch (err) {
    logger.debug('contact', `Foto de perfil nao disponivel para ${targetJid}: ${err.message}`);
    return null;
  }
}

/**
 * Obtém o status (Recado / Sobre) de um contato via USync Status Protocol.
 */
export async function fetchContactStatus(query, jidOrNumber) {
  let targetJid = String(jidOrNumber).trim();

  if (!targetJid.includes('@')) {
    const check = await checkWhatsAppNumber(query, targetJid);
    if (!check.exists) {
      return { jid: null, status: '', setAt: null };
    }
    targetJid = check.jid || `${formatPhoneNumber(targetJid)}@s.whatsapp.net`;
  }

  try {
    const res = await query({
      tag: 'iq',
      attrs: { to: '@s.whatsapp.net', type: 'get', xmlns: 'usync' },
      content: [
        {
          tag: 'usync',
          attrs: { sid: generateUSyncSid(), mode: 'query', last: 'true', index: '0', context: 'interactive' },
          content: [
            {
              tag: 'query',
              attrs: {},
              content: [{ tag: 'status', attrs: {} }]
            },
            {
              tag: 'list',
              attrs: {},
              content: [{
                tag: 'user',
                attrs: { jid: targetJid },
                content: []
              }]
            }
          ]
        }
      ]
    }, 10000);

    const usyncNode = (res.content || []).find(c => c && c.tag === 'usync');
    const listNode = usyncNode ? (usyncNode.content || []).find(c => c && c.tag === 'list') : null;
    const userNode = listNode ? (listNode.content || []).find(c => c && c.tag === 'user') : null;
    const statusNode = userNode ? (userNode.content || []).find(c => c && c.tag === 'status') : null;

    if (statusNode) {
      let raw = statusNode.content;
      let text = '';
      if (raw) {
        if (Buffer.isBuffer(raw)) text = raw.toString('utf-8');
        else if (raw instanceof Uint8Array) text = Buffer.from(raw).toString('utf-8');
        else if (typeof raw === 'object' && Array.isArray(raw.data)) text = Buffer.from(raw.data).toString('utf-8');
        else text = String(raw);
      }
      const setAt = statusNode.attrs?.t ? new Date(+statusNode.attrs.t * 1000).toISOString() : null;
      return {
        jid: targetJid,
        status: text,
        setAt
      };
    }
  } catch (err) {
    logger.debug('contact', `Status nao disponivel para ${targetJid}: ${err.message}`);
  }

  return {
    jid: targetJid,
    status: '',
    setAt: null
  };
}

/**
 * Resolve o LID correspondente a um número/JID via USync.
 */
export async function getLidForPn(query, jidOrNumber) {
  let targetJid = String(jidOrNumber).trim();
  if (!targetJid.includes('@')) {
    targetJid = `${formatPhoneNumber(targetJid)}@s.whatsapp.net`;
  }
  const cleanPhone = targetJid.split('@')[0];

  try {
    const res = await query({
      tag: 'iq',
      attrs: { to: '@s.whatsapp.net', type: 'get', xmlns: 'usync' },
      content: [
        {
          tag: 'usync',
          attrs: { sid: generateUSyncSid(), mode: 'query', last: 'true', index: '0', context: 'interactive' },
          content: [
            {
              tag: 'query',
              attrs: {},
              content: [
                { tag: 'contact', attrs: {} },
                { tag: 'lid', attrs: {} }
              ]
            },
            {
              tag: 'list',
              attrs: {},
              content: [{
                tag: 'user',
                attrs: {},
                content: [{ tag: 'contact', attrs: {}, content: '+' + cleanPhone }]
              }]
            }
          ]
        }
      ]
    }, 10000);

    const usyncNode = (res.content || []).find(c => c && c.tag === 'usync');
    const listNode = usyncNode ? (usyncNode.content || []).find(c => c && c.tag === 'list') : null;
    const userNode = listNode ? (listNode.content || []).find(c => c && c.tag === 'user') : null;
    const lidNode = userNode ? (userNode.content || []).find(c => c && c.tag === 'lid') : null;
    const lid = lidNode?.attrs?.val;
    const canonicalJid = userNode?.attrs?.jid || targetJid;
    return { lid, pnJid: canonicalJid };
  } catch (err) {
    return { lid: null, pnJid: targetJid };
  }
}

/**
 * Bloqueia ou desbloqueia um contato no WhatsApp (compatível com addressing_mode lid).
 */
export async function updateBlockStatus(query, jidOrNumber, action = 'block') {
  let clean = String(jidOrNumber).trim();
  const isLid = clean.endsWith('@lid');
  let lid = isLid ? clean : null;
  let pnJid = !isLid ? clean : null;

  if (!isLid) {
    const resolved = await getLidForPn(query, clean);
    lid = resolved.lid;
    pnJid = resolved.pnJid;
  }

  const itemAttrs = {
    action: action === 'unblock' ? 'unblock' : 'block',
    jid: lid || pnJid
  };

  if (action === 'block' && pnJid) {
    itemAttrs.pn_jid = pnJid;
  }

  await query({
    tag: 'iq',
    attrs: {
      xmlns: 'blocklist',
      to: '@s.whatsapp.net',
      type: 'set'
    },
    content: [
      {
        tag: 'item',
        attrs: itemAttrs
      }
    ]
  }, 10000);

  return {
    jid: pnJid || lid,
    action: action === 'unblock' ? 'unblock' : 'block',
    status: 'SUCCESS'
  };
}

/**
 * Lista todos os contatos bloqueados na conta.
 */
export async function fetchBlocklist(query) {
  try {
    const res = await query({
      tag: 'iq',
      attrs: {
        xmlns: 'blocklist',
        to: '@s.whatsapp.net',
        type: 'get'
      }
    }, 8000);

    const listNode = (res.content || []).find(c => c && c.tag === 'list');
    const items = listNode ? (listNode.content || []).filter(c => c && c.tag === 'item') : [];
    return items.map(item => item.attrs?.jid).filter(Boolean);
  } catch (err) {
    logger.debug('contact', `Erro ao buscar lista de bloqueados: ${err.message}`);
    return [];
  }
}

export function generatePreKeys(startId = 1, count = 50) {
  const preKeys = [];
  for (let i = 0; i < count; i++) {
    const keyId = startId + i;
    preKeys.push({
      keyId,
      keyPair: Curve.generateKeyPair()
    });
  }
  return preKeys;
}

const encodeBigEndian3 = (value) => {
  const buf = Buffer.alloc(3);
  let v = value;
  for (let i = 2; i >= 0; i--) {
    buf[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return buf;
};

const encodeBigEndian4 = (value) => {
  const buf = Buffer.alloc(4);
  let v = value;
  for (let i = 3; i >= 0; i--) {
    buf[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return buf;
};

export async function uploadPreKeys(query, creds, ev, count = 50) {
  if (!creds || !creds.signedIdentityKey || !creds.signedPreKey) return;
  if (!creds.preKeys) creds.preKeys = {};
  const existingKeys = Object.keys(creds.preKeys).map(Number).filter(n => !isNaN(n));
  const maxId = existingKeys.length > 0 ? Math.max(...existingKeys) : 0;

  if (existingKeys.length < 20) {
    const newPreKeys = generatePreKeys(maxId + 1, count);
    for (const k of newPreKeys) {
      creds.preKeys[k.keyId] = {
        public: Buffer.from(k.keyPair.public).toString('base64'),
        private: Buffer.from(k.keyPair.private).toString('base64')
      };
    }
    if (ev) ev.emit('creds.update', { preKeys: creds.preKeys });

    const S_WHATSAPP_NET = '@s.whatsapp.net';
    const iq = {
      tag: 'iq',
      attrs: {
        to: S_WHATSAPP_NET,
        type: 'set',
        xmlns: 'encrypt'
      },
      content: [
        { tag: 'registration', attrs: {}, content: encodeBigEndian4(creds.registrationId) },
        { tag: 'type', attrs: {}, content: Buffer.from([5]) },
        { tag: 'identity', attrs: {}, content: Buffer.from(creds.signedIdentityKey.public) },
        {
          tag: 'list',
          attrs: {},
          content: newPreKeys.map(k => ({
            tag: 'key',
            attrs: {},
            content: [
              { tag: 'id', attrs: {}, content: encodeBigEndian3(k.keyId) },
              { tag: 'value', attrs: {}, content: Buffer.from(k.keyPair.public) }
            ]
          }))
        },
        {
          tag: 'skey',
          attrs: {},
          content: [
            { tag: 'id', attrs: {}, content: encodeBigEndian3(creds.signedPreKey.keyId) },
            { tag: 'value', attrs: {}, content: Buffer.from(creds.signedPreKey.keyPair.public) },
            { tag: 'signature', attrs: {}, content: Buffer.from(creds.signedPreKey.signature) }
          ]
        }
      ]
    };

    try {
      await query(iq, 10000);
      logger.instance('prekeys', `Enviadas ${newPreKeys.length} novas pre-chaves ao WhatsApp.`);
    } catch (e) {
      logger.warn('prekeys', `Falha ao enviar pre-chaves ao WhatsApp: ${e.message}`);
    }
  }
}

/**
 * Atualiza o status/recado do próprio perfil da instância.
 */
export async function updateProfileStatus(query, statusText) {
  await query({
    tag: 'iq',
    attrs: {
      to: '@s.whatsapp.net',
      type: 'set',
      xmlns: 'status'
    },
    content: [
      {
        tag: 'status',
        attrs: {},
        content: Buffer.from(String(statusText), 'utf-8')
      }
    ]
  }, 10000);

  return { status: statusText, updated: true };
}

