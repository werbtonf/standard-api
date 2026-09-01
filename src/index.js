export { connectWA } from './client.js';
export { decodeBinaryNode, encodeBinaryNode } from './wabinary.js';
export { makeNoiseHandler } from './noise.js';
export { encodeMessage, decodeMessage } from './messages.js';
export { makeSignalRepository, fetchPreKeys, usyncUser } from './signal.js';
export { initAuthCreds, signPreKeys, normalizeCreds } from './auth.js';
export { encryptMedia, decryptMedia, prepareMediaMessage, getMediaBuffer } from './media.js';
export { WhatsAppInstance, InstanceManager } from './instance.js';

