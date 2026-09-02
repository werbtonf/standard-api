export const NOISE_MODE = 'Noise_XX_25519_AESGCM_SHA256\0\0\0\0';
export const DICT_VERSION = 3;
export const KEY_BUNDLE_TYPE = Buffer.from([5]);
export const NOISE_WA_HEADER = Buffer.from([87, 65, 6, DICT_VERSION]);
export const WA_CERT_DETAILS = {
  SERIAL: 0,
  ISSUER: 'WhatsAppLongTerm1',
  PUBLIC_KEY: Buffer.from('142375574d0a587166aae71ebe516437c4a28b73e3695c6ce1f7f9545da8ee6b', 'hex')
};
export const WA_WS_URL = 'wss://web.whatsapp.com/ws/chat';
export const S_WHATSAPP_NET = '@s.whatsapp.net';
export const CONNECT_TIMEOUT_MS = 20000;
export const KEEP_ALIVE_INTERVAL_MS = 30000;
