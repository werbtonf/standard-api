import libsignal from 'libsignal';
import { Curve, randomBytes } from './crypto.js';
import { KEY_BUNDLE_TYPE } from './auth.js';

export const generateSignalPubKey = (pubKey) => {
  if (!pubKey) return pubKey;
  const buf = Buffer.isBuffer(pubKey) ? pubKey : Buffer.from(pubKey);
  return buf.length === 33 ? buf : Buffer.concat([KEY_BUNDLE_TYPE, buf]);
};

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
          return libsignal.SessionRecord.deserialize(Buffer.isBuffer(sess) ? sess : Buffer.from(sess, 'base64'));
        } catch (e) {
          return null;
        }
      }
      return null;
    },

    async storeSession(id, record) {
      creds.sessions[id] = record.serialize().toString('base64');
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
 * Busca pré-chaves públicas do destinatário no servidor do WhatsApp.
 */
export async function fetchPreKeys(query, jid, repository) {
  const S_WHATSAPP_NET = 's.whatsapp.net';
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
        content: [
          { tag: 'user', attrs: { jid }, content: undefined }
        ]
      }
    ]
  };

  const result = await query(iq);
  const listNode = (result.content || []).find(c => c && c.tag === 'list');
  if (!listNode) throw new Error('no list node in pre-key response');

  const userNode = (listNode.content || []).find(c => c && c.tag === 'user');
  if (!userNode) throw new Error('user not found in pre-key response');

  const registrationNode = (userNode.content || []).find(c => c && c.tag === 'registration');
  const identityNode = (userNode.content || []).find(c => c && c.tag === 'identity');
  const skeyNode = (userNode.content || []).find(c => c && c.tag === 'skey');
  const preKeyNode = (userNode.content || []).find(c => c && c.tag === 'key');

  if (!identityNode || !skeyNode) {
    throw new Error('missing identity or signedPreKey in pre-key response');
  }

  const skeyIdNode = (skeyNode.content || []).find(c => c && c.tag === 'id');
  const skeyValNode = (skeyNode.content || []).find(c => c && c.tag === 'value');
  const skeySigNode = (skeyNode.content || []).find(c => c && c.tag === 'signature');

  const readBigEndian = (buf) => {
    if (!buf) return 0;
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    let val = 0;
    for (let i = 0; i < b.length; i++) {
      val = (val << 8) | b[i];
    }
    return val;
  };

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
  return sessionBundle;
}
