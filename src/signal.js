import libsignal from 'libsignal';
import { Curve, randomBytes } from './crypto.js';
import { KEY_BUNDLE_TYPE } from './auth.js';
import { logger } from './logger.js';

export const generateSignalPubKey = (pubKey) => {
  if (!pubKey) return pubKey;
  const buf = Buffer.isBuffer(pubKey) ? pubKey : Buffer.from(pubKey);
  return buf.length === 33 ? buf : Buffer.concat([KEY_BUNDLE_TYPE, buf]);
};

export function formatPhoneNumber(input, defaultCountryCode = '55') {
  let clean = String(input).trim().replace(/[^0-9]/g, '');
  if (!clean) return clean;
  if (clean.length === 10 || clean.length === 11) {
    clean = defaultCountryCode + clean;
  }
  return clean;
}

export function jidDecode(jid) {
  if (typeof jid !== 'string' || !jid.includes('@')) return null;
  const idx = jid.lastIndexOf('@');
  const userWithDevice = jid.slice(0, idx);
  let server = jid.slice(idx + 1);
  let user = userWithDevice;
  let device = 0;
  let domainType = 0;

  if (server === 'lid') domainType = 1;
  else if (server === 'hosted') domainType = 2;
  else if (server === 'hosted.lid') domainType = 3;

  const colon = userWithDevice.indexOf(':');
  if (colon !== -1) {
    user = userWithDevice.slice(0, colon);
    device = +userWithDevice.slice(colon + 1) || 0;
  }
  return { user, device, server, domainType };
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

  return {
    storage,
    hasSession,
    injectSession,
    encryptMessage,
    decryptMessage
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

/**
 * Busca pré-chaves públicas dos destinatários no servidor do WhatsApp em um único IQ em lote.
 */
export async function fetchPreKeys(query, devicesList, repository) {
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
          const node = { tag: 'user', attrs: { jid }, content: undefined };
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
    const result = await query(iq, 10000);
    const listNode = (result.content || []).find(c => c && c.tag === 'list');
    if (!listNode) return;

    const userNodes = (listNode.content || []).filter(c => c && c.tag === 'user');
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
    }
  } catch (err) {
    logger.debug('prekeys', `Busca em lote de pre-chaves: ${err.message}`);
  }
}

/**
 * Verifica se múltiplos números de telefone estão cadastrados no WhatsApp em uma única consulta USync em lote.
 */
export async function checkWhatsAppNumbers(query, rawNumbers) {
  const list = Array.isArray(rawNumbers) ? rawNumbers : [rawNumbers];
  const queryItems = [];

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

  // Monta lista única de telefones com "+" para enviar em 1 único USync IQ
  const allPhonesSet = new Set();
  for (const item of queryItems) {
    for (const p of item.variants) {
      allPhonesSet.add(p);
    }
  }

  const allPhones = Array.from(allPhonesSet);
  const phoneResults = new Map(); // phone -> { exists, jid }

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
              content: allPhones.map(p => ({
                tag: 'user',
                attrs: {},
                content: [{ tag: 'contact', attrs: {}, content: '+' + p }]
              }))
            }
          ]
        }
      ]
    }, 6000);

    const usyncNode = (res.content || []).find(c => c && c.tag === 'usync');
    const listNode = usyncNode ? (usyncNode.content || []).find(c => c && c.tag === 'list') : null;
    const userNodes = listNode ? (listNode.content || []).filter(c => c && c.tag === 'user') : [];

    for (const userNode of userNodes) {
      const contactNode = (userNode.content || []).find(c => c && c.tag === 'contact');
      const jid = userNode.attrs?.jid;
      const isRegistered = contactNode ? contactNode.attrs?.type !== 'out' : Boolean(jid);

      // Telefone retornado pelo nó de contato ou JID
      const contactPhone = contactNode?.content
        ? (Buffer.isBuffer(contactNode.content) ? contactNode.content.toString('utf-8') : String(contactNode.content)).replace(/[^0-9]/g, '')
        : null;
      const jidUser = jid ? jid.split('@')[0].split(':')[0] : null;

      const matchedPhone = contactPhone || jidUser;
      if (matchedPhone) {
        phoneResults.set(matchedPhone, {
          exists: isRegistered && Boolean(jid),
          jid: isRegistered ? jid : null
        });
      }
      if (jidUser && jidUser !== matchedPhone) {
        phoneResults.set(jidUser, {
          exists: isRegistered && Boolean(jid),
          jid: isRegistered ? jid : null
        });
      }
    }
  } catch (err) {
    console.error('[checkWhatsAppNumbers ERROR]:', err);
    logger.debug('contact', `Erro ao verificar lote de numeros USync: ${err.message}`);
  }

  // Mapeia de volta para cada entrada original
  const results = [];
  for (const item of queryItems) {
    let matched = null;
    for (const p of item.variants) {
      if (phoneResults.has(p) && phoneResults.get(p).exists) {
        matched = {
          exists: true,
          jid: phoneResults.get(p).jid,
          number: item.original
        };
        break;
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
  let jid = String(jidOrNumber).trim();
  if (!jid.includes('@')) {
    const formatted = formatPhoneNumber(jid);
    jid = `${formatted}@s.whatsapp.net`;
  }

  try {
    const res = await query({
      tag: 'iq',
      attrs: {
        target: jid,
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
    }, 8000);

    const pictureNode = (res.content || []).find(c => c && c.tag === 'picture');
    return pictureNode?.attrs?.url || null;
  } catch (err) {
    logger.debug('contact', `Foto de perfil nao disponivel para ${jid}: ${err.message}`);
    return null;
  }
}

/**
 * Obtém o status (Recado / Sobre) de um contato.
 */
export async function fetchContactStatus(query, jidOrNumber) {
  let jid = String(jidOrNumber).trim();
  if (!jid.includes('@')) {
    const formatted = formatPhoneNumber(jid);
    jid = `${formatted}@s.whatsapp.net`;
  }

  try {
    const res = await query({
      tag: 'iq',
      attrs: {
        to: '@s.whatsapp.net',
        type: 'get',
        xmlns: 'status'
      },
      content: [
        {
          tag: 'status',
          attrs: {},
          content: [{ tag: 'user', attrs: { jid } }]
        }
      ]
    }, 8000);

    const statusNode = (res.content || []).find(c => c && c.tag === 'status');
    const userNode = statusNode ? (statusNode.content || []).find(c => c && c.tag === 'user') : null;
    const text = userNode?.content
      ? (Buffer.isBuffer(userNode.content) ? userNode.content.toString('utf-8') : String(userNode.content))
      : (statusNode?.content ? (Buffer.isBuffer(statusNode.content) ? statusNode.content.toString('utf-8') : String(statusNode.content)) : null);
    const setAt = userNode?.attrs?.t ? new Date(+userNode.attrs.t * 1000).toISOString() : null;

    return {
      jid,
      status: text,
      setAt
    };
  } catch (err) {
    logger.debug('contact', `Status nao disponivel para ${jid}: ${err.message}`);
    return { jid, status: null, setAt: null };
  }
}

/**
 * Bloqueia ou desbloqueia um contato no WhatsApp.
 */
export async function updateBlockStatus(query, jidOrNumber, action = 'block') {
  let jid = String(jidOrNumber).trim();
  if (!jid.includes('@')) {
    const formatted = formatPhoneNumber(jid);
    jid = `${formatted}@s.whatsapp.net`;
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
        attrs: {
          action: action === 'unblock' ? 'unblock' : 'block',
          jid
        }
      }
    ]
  }, 8000);

  return {
    jid,
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
  }, 8000);

  return { status: statusText, updated: true };
}

