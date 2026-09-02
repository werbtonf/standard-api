import { NOISE_MODE, NOISE_WA_HEADER, WA_CERT_DETAILS } from '../../config/constants.js';
import { aesEncryptGCM, aesDecryptGCM, Curve, hkdf, sha256 } from './crypto.js';
import { decodeCertChain, decodeNoiseCertDetails } from '../binary/proto.js';

const IV_LENGTH = 12;
const EMPTY = Buffer.alloc(0);

const generateIV = (counter) => {
  const iv = new Uint8Array(IV_LENGTH);
  new DataView(iv.buffer).setUint32(8, counter);
  return Buffer.from(iv);
};

/**
 * TransportState: criptografia AES-GCM dos frames após o handshake.
 * Contador incremental (32 bits) usado como parte do IV.
 */
class TransportState {
  constructor(encKey, decKey) {
    this.encKey = encKey;
    this.decKey = decKey;
    this.readCounter = 0;
    this.writeCounter = 0;
    this.iv = Buffer.alloc(IV_LENGTH);
  }

  encrypt(plaintext) {
    const c = this.writeCounter++;
    const iv = Buffer.from(this.iv);
    iv[8] = (c >>> 24) & 0xff;
    iv[9] = (c >>> 16) & 0xff;
    iv[10] = (c >>> 8) & 0xff;
    iv[11] = c & 0xff;
    return aesEncryptGCM(plaintext, this.encKey, iv, EMPTY);
  }

  decrypt(ciphertext) {
    const c = this.readCounter++;
    const iv = Buffer.from(this.iv);
    iv[8] = (c >>> 24) & 0xff;
    iv[9] = (c >>> 16) & 0xff;
    iv[10] = (c >>> 8) & 0xff;
    iv[11] = c & 0xff;
    return aesDecryptGCM(ciphertext, this.decKey, iv, EMPTY);
  }
}

/**
 * Handler do protocolo Noise XX_25519_AESGCM_SHA256 do WhatsApp.
 */
export function makeNoiseHandler({ keyPair, routingInfo }) {
  const data = Buffer.from(NOISE_MODE, 'utf8');
  let hash = data.length === 32 ? data : sha256(data);
  let salt = hash;
  let encKey = hash;
  let decKey = hash;
  let counter = 0;
  let sentIntro = false;
  let inBytes = Buffer.alloc(0);
  let transport = null;
  let isWaitingForTransport = false;
  let pendingOnFrame = null;

  let introHeader;
  if (routingInfo) {
    introHeader = Buffer.alloc(7 + routingInfo.length + NOISE_WA_HEADER.length);
    introHeader.write('ED', 0, 'utf8');
    introHeader.writeUint8(0, 2);
    introHeader.writeUint8(1, 3);
    introHeader.writeUint8(routingInfo.length >> 16, 4);
    introHeader.writeUint16BE(routingInfo.length & 0xffff, 5);
    introHeader.set(routingInfo, 7);
    introHeader.set(NOISE_WA_HEADER, 7 + routingInfo.length);
  } else {
    introHeader = NOISE_WA_HEADER;
  }

  const authenticate = (data) => {
    if (!transport) {
      hash = sha256(Buffer.concat([hash, data]));
    }
  };

  const encrypt = (plaintext) => {
    if (transport) {
      return transport.encrypt(plaintext);
    }
    const result = aesEncryptGCM(plaintext, encKey, generateIV(counter++), hash);
    authenticate(result);
    return result;
  };

  const decrypt = (ciphertext) => {
    if (transport) {
      return transport.decrypt(ciphertext);
    }
    const result = aesDecryptGCM(ciphertext, decKey, generateIV(counter++), hash);
    authenticate(ciphertext);
    return result;
  };

  const localHKDF = (data) => {
    const key = hkdf(Buffer.from(data), 64, { salt, info: EMPTY });
    return [key.subarray(0, 32), key.subarray(32)];
  };

  const mixIntoKey = (data) => {
    const [write, read] = localHKDF(data);
    salt = write;
    encKey = read;
    decKey = read;
    counter = 0;
  };

  const finishInit = async () => {
    isWaitingForTransport = true;
    const [write, read] = localHKDF(EMPTY);
    transport = new TransportState(write, read);
    isWaitingForTransport = false;
    if (pendingOnFrame) {
      await processData(pendingOnFrame);
      pendingOnFrame = null;
    }
  };

  const processData = async (onFrame) => {
    let size;
    while (true) {
      if (inBytes.length < 3) return;
      size = (inBytes[0] << 16) | (inBytes[1] << 8) | inBytes[2];
      if (inBytes.length < size + 3) return;
      let frame = inBytes.subarray(3, size + 3);
      inBytes = inBytes.subarray(size + 3);
      try {
        if (transport) {
          const result = transport.decrypt(frame);
          onFrame(result);
        } else {
          onFrame(frame);
        }
      } catch (e) {
        console.error('[noise] frame decrypt failed:', e.message);
        throw e;
      }
    }
  };

  authenticate(NOISE_WA_HEADER);
  authenticate(keyPair.public);

  return {
    encrypt,
    decrypt,
    authenticate,
    mixIntoKey,
    finishInit,

    async processHandshake({ serverHello }, noiseKey) {
      authenticate(serverHello.ephemeral);
      mixIntoKey(await Curve.sharedKey(keyPair.private, serverHello.ephemeral));

      const decStaticContent = decrypt(serverHello.static);
      mixIntoKey(await Curve.sharedKey(keyPair.private, decStaticContent));

      const certDecoded = decrypt(serverHello.payload);
      const { leaf, intermediate } = decodeCertChain(certDecoded);

      // validação da cadeia de certificados
      const details = decodeNoiseCertDetails(intermediate.details);
      const verifyLeaf = await Curve.verify(
        decodeNoiseCertDetails(intermediate.details).key,
        leaf.details,
        leaf.signature
      );
      const verifyIntermediate = await Curve.verify(
        WA_CERT_DETAILS.PUBLIC_KEY,
        intermediate.details,
        intermediate.signature
      );
      if (!verifyLeaf) throw new Error('noise certificate signature invalid');
      if (!verifyIntermediate) throw new Error('noise intermediate certificate signature invalid');
      if (details.issuerSerial !== WA_CERT_DETAILS.SERIAL) {
        throw new Error('certification match failed');
      }

      const keyEnc = encrypt(noiseKey.public);
      mixIntoKey(await Curve.sharedKey(noiseKey.private, serverHello.ephemeral));
      return keyEnc;
    },

    encodeFrame(data) {
      if (transport) {
        data = transport.encrypt(data);
      }
      const dataLen = data.length;
      const introSize = sentIntro ? 0 : introHeader.length;
      const frame = Buffer.alloc(introSize + 3 + dataLen);
      if (!sentIntro) {
        frame.set(introHeader);
        sentIntro = true;
      }
      frame[introSize] = (dataLen >>> 16) & 0xff;
      frame[introSize + 1] = (dataLen >>> 8) & 0xff;
      frame[introSize + 2] = dataLen & 0xff;
      frame.set(data, introSize + 3);
      return frame;
    },

    decodeFrame(newData, onFrame) {
      if (isWaitingForTransport) {
        inBytes = Buffer.concat([inBytes, newData]);
        pendingOnFrame = onFrame;
        return;
      }
      inBytes = inBytes.length === 0 ? Buffer.from(newData) : Buffer.concat([inBytes, newData]);
      processData(onFrame);
    }
  };
}
