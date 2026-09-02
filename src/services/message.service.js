import { MessageProto } from '../core/binary/waproto.js';

export const writeRandomPadMax16 = (msg) => {
  const pad = randomBytes(1);
  const padLength = (pad[0] & 0x0f) + 1;
  return Buffer.concat([msg, Buffer.alloc(padLength, padLength)]);
};

import { randomBytes } from 'node:crypto';

export const unpadRandomMax16 = (e) => {
  const t = Buffer.from(e);
  if (t.length === 0) return t;
  const pad = t[t.length - 1];
  if (pad > t.length || pad > 16 || pad === 0) return t;
  return t.subarray(0, t.length - pad);
};

/**
 * Converte um objeto protobufjs (Message/Array/Long/Buffer) em plain JS
 * serializável: Long -> Number, Uint8Array -> Buffer, recursivo.
 */
export function toPlain(value) {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return value.map(toPlain);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'object') {
    if ('low' in value && 'high' in value) {
      const v = Number(value);
      return Number.isSafeInteger(v) ? v : value.toString();
    }
    if (value.toJSON && !Array.isArray(value) && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      const j = value.toJSON();
      if (j !== undefined && typeof j !== 'object') return j;
    }
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = toPlain(value[k]);
    }
    return out;
  }
  return value;
}

const WRAPPER_KEYS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'ephemeralMessage', 'documentWithCaptionMessage', 'editedMessage'];

function unwrapWrappers(message) {
  for (const w of WRAPPER_KEYS) {
    const inner = message && message[w];
    if (inner && inner.message) return inner.message;
    if (inner && w === 'editedMessage') {
      const em = inner.directEditedMessage || inner.message;
      if (em) return em;
    }
  }
  return message;
}

/**
 * Tipos de mensagem conhecidos (ordem de prioridade, igual getContentType do Baileys).
 */
const MESSAGE_KEY_ORDER = [
  'conversation', 'extendedTextMessage', 'imageMessage', 'documentMessage', 'audioMessage',
  'videoMessage', 'stickerMessage', 'reactionMessage', 'protocolMessage', 'pollCreationMessage',
  'pollUpdateMessage', 'buttonsMessage', 'buttonsResponseMessage', 'listMessage', 'listResponseMessage',
  'locationMessage', 'liveLocationMessage', 'contactMessage', 'contactsArrayMessage', 'eventMessage',
  'viewOnceMessage', 'viewOnceMessageV2', 'ephemeralMessage', 'documentWithCaptionMessage', 'editedMessage'
];

export function getMessageType(message) {
  if (!message) return 'conversation';
  for (const k of MESSAGE_KEY_ORDER) {
    if (message[k]) return k;
  }
  return 'conversation';
}

/**
 * Codifica um objeto Message em bytes Protobuf COM padding PKCS7 aleatório
 * (padrão WhatsApp), via schema WAProto completo.
 */
export function encodeMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    throw new Error('encodeMessage: mensagem inválida.');
  }

  const payload = normalizeForEncode(msg);
  const bytes = MessageProto.encode(MessageProto.create(payload)).finish();
  return writeRandomPadMax16(Buffer.from(bytes));
}

function normalizeForEncode(msg) {
  if (msg.conversation) return { conversation: msg.conversation };
  if (msg.react) return { reactionMessage: msg.react };
  if (msg.text) {
    if (msg.contextInfo || msg.mentions) {
      const ctx = { ...(msg.contextInfo || {}) };
      if (msg.mentions) ctx.mentionedJid = msg.mentions;
      return {
        extendedTextMessage: {
          text: msg.text,
          contextInfo: ctx
        }
      };
    }
    return { conversation: msg.text };
  }
  // Demais tipos já usam os mesmos nomes de campos do WAProto
  const out = {};
  for (const k of Object.keys(msg)) {
    if (k === 'raw' || k === 'base64' || k === 'rawError') continue;
    out[k] = msg[k];
  }
  if (Object.keys(out).length === 0) {
    out.conversation = '';
  }
  return out;
}

/**
 * Decodifica bytes Protobuf em um objeto Message amigável (WAProto completo).
 */
export function decodeMessage(buf) {
  if (!buf || !buf.length) return {};
  try {
    const unpadded = unpadRandomMax16(buf);
    const msg = MessageProto.decode(unpadded);
    const inner = unwrapWrappers(msg);
    return toPlain(inner || msg);
  } catch (e) {
    console.error('[decodeMessage] erro ao decodificar:', e.message);
    return { raw: buf };
  }
}

/**
 * Extrai texto exibível de um Message plain (para logs/preview).
 */
export function getDisplayText(message) {
  if (!message) return '';
  const type = getMessageType(message);
  switch (type) {
    case 'conversation': return message.conversation || '';
    case 'extendedTextMessage': return message.extendedTextMessage?.text || '';
    case 'imageMessage': case 'videoMessage': case 'documentMessage':
      return message[type]?.caption || '';
    case 'reactionMessage': return message.reactionMessage?.text || '';
    case 'buttonsResponseMessage': return message.buttonsResponseMessage?.selectedDisplayText || '';
    case 'listResponseMessage': return message.listResponseMessage?.title || '';
    case 'interactiveResponseMessage':
      try {
        const p = JSON.parse(message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson || '[]');
        return (Array.isArray(p) && p[0]?.response) || '';
      } catch { return ''; }
    default: return '';
  }
}
