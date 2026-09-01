import crypto from 'node:crypto';

// --- utilidades de hash ---

export const sha256 = (data) =>
  crypto.createHash('sha256').update(data).digest();

export const hmac = (key, data) =>
  crypto.createHmac('sha256', key).update(data).digest();

/**
 * HKDF (RFC 5869) com SHA-256.
 * @param {Buffer} ikm input key material
 * @param {number} length tamanho da saída em bytes
 * @param {{salt?: Buffer, info?: Buffer}} opts
 */
export function hkdf(ikm, length, { salt = Buffer.alloc(32), info = Buffer.alloc(0) } = {}) {
  const prk = hmac(salt, ikm);
  let out = Buffer.alloc(0);
  let t = Buffer.alloc(0);
  let counter = 1;
  while (out.length < length) {
    t = hmac(prk, Buffer.concat([t, info, Buffer.from([counter])]));
    out = Buffer.concat([out, t]);
    counter++;
  }
  return out.subarray(0, length);
}

// --- AES-256-GCM ---

export const aesEncryptGCM = (plaintext, key, iv, aad) => {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad.length) cipher.setAAD(aad);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([enc, cipher.getAuthTag()]);
};

export const aesDecryptGCM = (ciphertext, key, iv, aad) => {
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad.length) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
};

// --- AES-256-CBC (WhatsApp Media Cipher) ---

export const aesEncryptCBC = (plaintext, key, iv) => {
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
};

export const aesDecryptCBC = (ciphertext, key, iv) => {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

// --- X25519 (Curve25519) ---
// Usa o key exchange "x25519" nativo do Node (crypto.diffieHellman)
// que aceita chaves privadas X25519 exportadas no formato PKCS8.

const PRIVATE_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const PUBLIC_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export const Curve = {
  generateKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    return {
      private: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32),
      public: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
    };
  },

  sharedKey(privateKey, publicKey) {
    const privDer = Buffer.concat([PRIVATE_PREFIX, privateKey]);
    const pubDer = Buffer.concat([PUBLIC_PREFIX, publicKey]);
    const priv = crypto.createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
    const pub = crypto.createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
    return crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  },

  /**
   * Verifica uma assinatura Ed25519 (via curve25519-js, como o libsignal faz).
   */
  async verify(publicKey, message, signature) {
    const { verify: edVerify } = await import('curve25519-js');
    const keyBytes = publicKey.length === 33 ? publicKey.subarray(1) : publicKey;
    return edVerify(
      new Uint8Array(keyBytes),
      new Uint8Array(message),
      new Uint8Array(signature)
    );
  },

  /**
   * Assina uma mensagem com Ed25519 (via curve25519-js).
   */
  async sign(privateKey, message) {
    const { sign: edSign } = await import('curve25519-js');
    return Buffer.from(edSign(new Uint8Array(privateKey), new Uint8Array(message)));
  }
};

export const hmacSign = (buffer, key, variant = 'sha256') =>
  crypto.createHmac(variant, key).update(buffer).digest();

export const randomBytes = (n) => crypto.randomBytes(n);
