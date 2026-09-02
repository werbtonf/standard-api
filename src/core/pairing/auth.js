import { Curve, randomBytes } from '../crypto/crypto.js';
import { encodeDeviceProps, encodeClientPayload } from '../binary/proto.js';
import { createHash } from 'node:crypto';

export const KEY_BUNDLE_TYPE = Buffer.from([5]);

/** Codifica número em big-endian de n bytes (ex.: regid de 3 bytes). */
const encodeBigEndian = (value, n = 4) => {
  const buf = Buffer.alloc(n);
  let v = value;
  for (let i = n - 1; i >= 0; i--) {
    buf[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return buf;
};

/** Normaliza credenciais restauradas de JSON garantindo que Buffers sejam recriados. */
export function normalizeCreds(creds) {
  if (!creds) return creds;
  const toBuffer = (b) => {
    if (!b) return b;
    if (Buffer.isBuffer(b)) return b;
    if (typeof b === 'object' && b.type === 'Buffer' && Array.isArray(b.data)) return Buffer.from(b.data);
    if (b instanceof Uint8Array || Array.isArray(b)) return Buffer.from(b);
    return b;
  };
  const normalizeKeyPair = (kp) => {
    if (!kp) return kp;
    return {
      public: toBuffer(kp.public),
      private: toBuffer(kp.private)
    };
  };

  if (creds.noiseKey) creds.noiseKey = normalizeKeyPair(creds.noiseKey);
  if (creds.signedIdentityKey) creds.signedIdentityKey = normalizeKeyPair(creds.signedIdentityKey);
  if (creds.signedPreKey) {
    if (creds.signedPreKey.keyPair) creds.signedPreKey.keyPair = normalizeKeyPair(creds.signedPreKey.keyPair);
    if (creds.signedPreKey.signature) creds.signedPreKey.signature = toBuffer(creds.signedPreKey.signature);
  }
  if (creds.routingInfo) creds.routingInfo = toBuffer(creds.routingInfo);
  if (creds.account) {
    if (creds.account.details) creds.account.details = toBuffer(creds.account.details);
    if (creds.account.accountSignatureKey) creds.account.accountSignatureKey = toBuffer(creds.account.accountSignatureKey);
    if (creds.account.accountSignature) creds.account.accountSignature = toBuffer(creds.account.accountSignature);
    if (creds.account.deviceSignature) creds.account.deviceSignature = toBuffer(creds.account.deviceSignature);
  }
  return creds;
}

/** Gera a identidade Signal de um novo dispositivo. */
export function initAuthCreds() {
  const identityKeyPair = Curve.generateKeyPair();
  return {
    noiseKey: Curve.generateKeyPair(),
    signedIdentityKey: identityKeyPair,
    signedPreKey: {
      keyId: Math.floor(Math.random() * 0xffffff),
      keyPair: Curve.generateKeyPair(),
      signature: null
    },
    registrationId: Math.floor(Math.random() * 0x3fff),
    advSecretKey: randomBytes(32).toString('base64')
  };
}

/**
 * Assina a signedPreKey com a identidade.
 * @param {object} creds identidade
 */
export async function signPreKeys(creds) {
  normalizeCreds(creds);
  const pubKey = Buffer.concat([KEY_BUNDLE_TYPE, creds.signedPreKey.keyPair.public]);
  const signature = await sign(creds.signedIdentityKey.private, pubKey);
  creds.signedPreKey.signature = signature;
  return creds;
}

// Assinatura Ed25519 via curve25519-js
export async function sign(privateKey, message) {
  const { sign: edSign } = await import('curve25519-js');
  return Buffer.from(edSign(new Uint8Array(privateKey), new Uint8Array(message)));
}

/**
 * Monta o ClientPayload de registro de um dispositivo novo.
 */
export async function buildRegistrationPayload(creds, config) {
  const appVersionBuf = createHash('md5').update(config.version.join('.')).digest();
  const companion = {
    os: config.browser[0],
    platformType: getPlatformType(config.browser[1]),
    requireFullSync: true,
    historySyncConfig: {
      storageQuotaMb: 10240,
      inlineInitialPayloadInE2EeMsg: true,
      supportCallLogHistory: false,
      supportBotUserAgentChatHistory: true,
      supportCagReactionsAndPolls: true,
      supportBizHostedMsg: true,
      supportRecentSyncChunkMessageCountTuning: true,
      supportHostedGroupMsg: true,
      supportFbidBotChatHistory: true,
      supportMessageAssociation: true,
      supportGroupHistory: false,
      supportGuestChat: undefined
    },
    version: { primary: 10, secondary: 15, tertiary: 7 }
  };
  const companionProto = encodeDeviceProps(companion);

  const regIdBuf = encodeBigEndian(creds.registrationId); // 4 bytes (default)
  const skeyIdBuf = encodeBigEndian(creds.signedPreKey.keyId, 3);

  return encodeClientPayload({
    passive: false,
    pull: false,
    userAgent: buildUserAgent(config),
    webInfo: { webSubPlatform: 0 },
    connectType: 1,
    connectReason: 1,
    devicePairingData: {
      buildHash: appVersionBuf,
      deviceProps: companionProto,
      eRegid: regIdBuf,
      eKeytype: KEY_BUNDLE_TYPE,
      eIdent: creds.signedIdentityKey.public,
      eSkeyId: skeyIdBuf,
      eSkeyVal: creds.signedPreKey.keyPair.public,
      eSkeySig: creds.signedPreKey.signature
    }
  });
}

/** Monta o ClientPayload de login (dispositivo já pareado). */
export function buildLoginPayload(creds, config) {
  return encodeClientPayload({
    passive: true,
    pull: true,
    userAgent: buildUserAgent(config),
    webInfo: { webSubPlatform: 0 },
    pushName: config.pushName,
    connectType: 1,
    connectReason: 1,
    username: +jidUser(creds.me.id),
    device: jidDevice(creds.me.id),
    lidDbMigrated: false
  });
}

const buildUserAgent = (config) => {
  const ua = {
    appVersion: {
      primary: config.version[0],
      secondary: config.version[1],
      tertiary: config.version[2]
    },
    platform: 14, // WEB
    releaseChannel: 0, // RELEASE
    mcc: '000',
    mnc: '000',
    osVersion: '0.1',
    device: 'Desktop',
    osBuildNumber: '0.1',
    localeLanguageIso6391: 'en',
    localeCountryIso31661Alpha2: 'US'
  };
  if (config.version[3]) ua.appVersion.quaternary = config.version[3];
  return ua;
};

const getPlatformType = (platform) => {
  const p = platform.toUpperCase();
  switch (p) {
    case 'CHROME': return 1;
    case 'FIREFOX': return 2;
    case 'SAFARI': return 5;
    case 'EDGE': return 6;
    default: return 1;
  }
};

const jidUser = (jid) => {
  if (!jid) return '';
  const idx = jid.indexOf('@');
  return idx === -1 ? jid : jid.slice(0, idx);
};

const jidDevice = (jid) => {
  if (!jid) return 0;
  const colon = jid.indexOf(':');
  if (colon === -1) return 0;
  return +jid.slice(colon + 1) || 0;
};

/** Constrói o QR de pareamento (formato wa.me/settings/linked_devices#ref,noise,ident,adv,platform) */
export function buildPairingQRData(ref, creds, browser) {
  const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64');
  const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64');
  const advB64 = creds.advSecretKey;
  const platformId = getCompanionPlatformId(browser);
  return `https://wa.me/settings/linked_devices#${[ref, noiseKeyB64, identityKeyB64, advB64, platformId].join(',')}`;
}

const getCompanionWebClientType = ([os, browserName]) => {
  if (browserName === 'Desktop') {
    return os === 'Windows' ? 8 : 7; // UWP : ELECTRON
  }
  switch (browserName) {
    case 'Chrome': return 1;
    case 'Edge': return 2;
    case 'Firefox': return 3;
    case 'IE': return 4;
    case 'Opera': return 5;
    case 'Safari': return 6;
    default: return 9; // OTHER_WEB_CLIENT
  }
};

const getCompanionPlatformId = (browser) => getCompanionWebClientType(browser).toString();
