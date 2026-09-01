import {
  encodeBytes,
  encodeVarint,
  decodeGeneric,
  readVarint,
  readField,
  WIRE_LENGTH_DELIMITED,
  WIRE_VARINT
} from './proto.js';

/**
 * Codifica um objeto Message em bytes Protobuf.
 * Suporta:
 *  - conversation (field 1)
 *  - extendedTextMessage (field 6)
 *  - reactionMessage (field 46)
 */
export function encodeMessage(msg) {
  if (typeof msg === 'string') {
    return encodeMessage({ conversation: msg });
  }

  const parts = [];

  if (msg.conversation) {
    parts.push(encodeBytes(1, Buffer.from(msg.conversation, 'utf8')));
  } else if (msg.text) {
    if (msg.contextInfo || msg.mentions) {
      parts.push(encodeBytes(6, encodeExtendedTextMessage({
        text: msg.text,
        contextInfo: msg.contextInfo,
        mentionedJid: msg.mentions
      })));
    } else {
      parts.push(encodeBytes(1, Buffer.from(msg.text, 'utf8')));
    }
  } else if (msg.extendedTextMessage) {
    parts.push(encodeBytes(6, encodeExtendedTextMessage(msg.extendedTextMessage)));
  } else if (msg.react || msg.reactionMessage) {
    const r = msg.react || msg.reactionMessage;
    parts.push(encodeBytes(46, encodeReactionMessage(r)));
  }

  return Buffer.concat(parts);
}

function encodeExtendedTextMessage(ext) {
  const parts = [];
  if (ext.text) parts.push(encodeBytes(1, Buffer.from(ext.text, 'utf8')));
  if (ext.contextInfo || ext.mentionedJid) {
    parts.push(encodeBytes(17, encodeContextInfo(ext.contextInfo || {}, ext.mentionedJid)));
  }
  return Buffer.concat(parts);
}

function encodeContextInfo(ctx = {}, mentions = []) {
  const parts = [];
  if (ctx.stanzaId) parts.push(encodeBytes(1, Buffer.from(ctx.stanzaId, 'utf8')));
  if (ctx.participant) parts.push(encodeBytes(2, Buffer.from(ctx.participant, 'utf8')));
  if (ctx.quotedMessage) parts.push(encodeBytes(3, encodeMessage(ctx.quotedMessage)));
  const allMentions = ctx.mentionedJid || mentions || [];
  for (const m of allMentions) {
    parts.push(encodeBytes(15, Buffer.from(m, 'utf8')));
  }
  return Buffer.concat(parts);
}

function encodeReactionMessage(r) {
  const parts = [];
  if (r.key) {
    const kp = [];
    if (r.key.remoteJid) kp.push(encodeBytes(1, Buffer.from(r.key.remoteJid, 'utf8')));
    if (r.key.fromMe !== undefined) kp.push(encodeVarint(2, r.key.fromMe ? 1 : 0));
    if (r.key.id) kp.push(encodeBytes(3, Buffer.from(r.key.id, 'utf8')));
    if (r.key.participant) kp.push(encodeBytes(4, Buffer.from(r.key.participant, 'utf8')));
    parts.push(encodeBytes(1, Buffer.concat(kp)));
  }
  if (r.text !== undefined) parts.push(encodeBytes(2, Buffer.from(r.text, 'utf8')));
  if (r.senderTimestampMs) parts.push(encodeVarint(3, r.senderTimestampMs));
  return Buffer.concat(parts);
}

/**
 * Decodifica bytes Protobuf em um objeto Message amigável.
 */
export function decodeMessage(buf) {
  if (!buf || !buf.length) return {};
  try {
    const o = decodeGeneric(buf);
    const msg = {};

    if (o[1] && o[1][0]) {
      msg.conversation = o[1][0].toString('utf8');
    }

    if (o[6] && o[6][0]) {
      const ext = decodeGeneric(o[6][0]);
      msg.extendedTextMessage = {
        text: ext[1] && ext[1][0] ? ext[1][0].toString('utf8') : '',
        contextInfo: ext[17] && ext[17][0] ? decodeContextInfo(ext[17][0]) : undefined
      };
      if (!msg.conversation) {
        msg.conversation = msg.extendedTextMessage.text;
      }
    }

    if (o[46] && o[46][0]) {
      const r = decodeGeneric(o[46][0]);
      msg.reactionMessage = {
        text: r[2] && r[2][0] ? r[2][0].toString('utf8') : '',
        key: r[1] && r[1][0] ? decodeMessageKey(r[1][0]) : undefined
      };
    }

    return msg;
  } catch (e) {
    console.error('[decodeMessage] erro ao decodificar:', e.message);
    return { raw: buf };
  }
}

function decodeMessageKey(buf) {
  const o = decodeGeneric(buf);
  return {
    remoteJid: o[1] && o[1][0] ? o[1][0].toString('utf8') : undefined,
    fromMe: o[2] && o[2][0] ? o[2][0] === 1 : false,
    id: o[3] && o[3][0] ? o[3][0].toString('utf8') : undefined,
    participant: o[4] && o[4][0] ? o[4][0].toString('utf8') : undefined
  };
}

function decodeContextInfo(buf) {
  const o = decodeGeneric(buf);
  return {
    stanzaId: o[1] && o[1][0] ? o[1][0].toString('utf8') : undefined,
    participant: o[2] && o[2][0] ? o[2][0].toString('utf8') : undefined,
    quotedMessage: o[3] && o[3][0] ? decodeMessage(o[3][0]) : undefined,
    mentionedJid: (o[15] || []).map(b => b.toString('utf8'))
  };
}
