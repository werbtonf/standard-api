import { randomBytes } from 'node:crypto';
import {
  encodeBytes,
  encodeVarint,
  decodeGeneric
} from '../core/binary/proto.js';

export const writeRandomPadMax16 = (msg) => {
  const pad = randomBytes(1);
  const padLength = (pad[0] & 0x0f) + 1;
  return Buffer.concat([msg, Buffer.alloc(padLength, padLength)]);
};

export const unpadRandomMax16 = (e) => {
  const t = Buffer.from(e);
  if (t.length === 0) return t;
  const pad = t[t.length - 1];
  if (pad > t.length || pad > 16 || pad === 0) return t;
  return t.subarray(0, t.length - pad);
};

/**
 * Codifica um objeto Message em bytes Protobuf COM padding PKCS7 aleatório (padrão WhatsApp).
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
  } else if (msg.imageMessage) {
    parts.push(encodeBytes(3, encodeImageMessage(msg.imageMessage)));
  } else if (msg.documentMessage) {
    parts.push(encodeBytes(7, encodeDocumentMessage(msg.documentMessage)));
  } else if (msg.audioMessage) {
    parts.push(encodeBytes(8, encodeAudioMessage(msg.audioMessage)));
  } else if (msg.videoMessage) {
    parts.push(encodeBytes(9, encodeVideoMessage(msg.videoMessage)));
  } else if (msg.stickerMessage) {
    parts.push(encodeBytes(26, encodeStickerMessage(msg.stickerMessage)));
  } else if (msg.react || msg.reactionMessage) {
    const r = msg.react || msg.reactionMessage;
    parts.push(encodeBytes(46, encodeReactionMessage(r)));
  }

  const rawBytes = Buffer.concat(parts);
  return writeRandomPadMax16(rawBytes);
}

function encodeExtendedTextMessage(ext) {
  const parts = [];
  if (ext.text) parts.push(encodeBytes(1, Buffer.from(ext.text, 'utf8')));
  if (ext.contextInfo || ext.mentionedJid) {
    parts.push(encodeBytes(17, encodeContextInfo(ext.contextInfo || {}, ext.mentionedJid)));
  }
  return Buffer.concat(parts);
}

function encodeImageMessage(img) {
  const parts = [];
  if (img.url) parts.push(encodeBytes(1, Buffer.from(img.url, 'utf8')));
  if (img.mimetype) parts.push(encodeBytes(2, Buffer.from(img.mimetype, 'utf8')));
  if (img.caption) parts.push(encodeBytes(3, Buffer.from(img.caption, 'utf8')));
  if (img.fileSha256) parts.push(encodeBytes(4, toBuffer(img.fileSha256)));
  if (img.fileLength) parts.push(encodeVarint(5, img.fileLength));
  if (img.height) parts.push(encodeVarint(6, img.height));
  if (img.width) parts.push(encodeVarint(7, img.width));
  if (img.mediaKey) parts.push(encodeBytes(8, toBuffer(img.mediaKey)));
  if (img.fileEncSha256) parts.push(encodeBytes(9, toBuffer(img.fileEncSha256)));
  if (img.directPath) parts.push(encodeBytes(11, Buffer.from(img.directPath, 'utf8')));
  if (img.mediaKeyTimestamp) parts.push(encodeVarint(12, img.mediaKeyTimestamp));
  if (img.jpegThumbnail) parts.push(encodeBytes(16, toBuffer(img.jpegThumbnail)));
  if (img.contextInfo) parts.push(encodeBytes(17, encodeContextInfo(img.contextInfo)));
  return Buffer.concat(parts);
}

function encodeDocumentMessage(doc) {
  const parts = [];
  if (doc.url) parts.push(encodeBytes(1, Buffer.from(doc.url, 'utf8')));
  if (doc.mimetype) parts.push(encodeBytes(2, Buffer.from(doc.mimetype, 'utf8')));
  if (doc.title) parts.push(encodeBytes(3, Buffer.from(doc.title, 'utf8')));
  if (doc.fileSha256) parts.push(encodeBytes(4, toBuffer(doc.fileSha256)));
  if (doc.fileLength) parts.push(encodeVarint(5, doc.fileLength));
  if (doc.pageCount) parts.push(encodeVarint(6, doc.pageCount));
  if (doc.mediaKey) parts.push(encodeBytes(7, toBuffer(doc.mediaKey)));
  if (doc.fileName) parts.push(encodeBytes(8, Buffer.from(doc.fileName, 'utf8')));
  if (doc.fileEncSha256) parts.push(encodeBytes(9, toBuffer(doc.fileEncSha256)));
  if (doc.directPath) parts.push(encodeBytes(10, Buffer.from(doc.directPath, 'utf8')));
  if (doc.mediaKeyTimestamp) parts.push(encodeVarint(11, doc.mediaKeyTimestamp));
  if (doc.contextInfo) parts.push(encodeBytes(17, encodeContextInfo(doc.contextInfo)));
  return Buffer.concat(parts);
}

function encodeAudioMessage(aud) {
  const parts = [];
  if (aud.url) parts.push(encodeBytes(1, Buffer.from(aud.url, 'utf8')));
  if (aud.mimetype) parts.push(encodeBytes(2, Buffer.from(aud.mimetype, 'utf8')));
  if (aud.fileSha256) parts.push(encodeBytes(3, toBuffer(aud.fileSha256)));
  if (aud.fileLength) parts.push(encodeVarint(4, aud.fileLength));
  if (aud.seconds) parts.push(encodeVarint(5, aud.seconds));
  if (aud.ptt !== undefined) parts.push(encodeVarint(6, aud.ptt ? 1 : 0));
  if (aud.mediaKey) parts.push(encodeBytes(7, toBuffer(aud.mediaKey)));
  if (aud.fileEncSha256) parts.push(encodeBytes(8, toBuffer(aud.fileEncSha256)));
  if (aud.directPath) parts.push(encodeBytes(9, Buffer.from(aud.directPath, 'utf8')));
  if (aud.mediaKeyTimestamp) parts.push(encodeVarint(10, aud.mediaKeyTimestamp));
  if (aud.contextInfo) parts.push(encodeBytes(17, encodeContextInfo(aud.contextInfo)));
  return Buffer.concat(parts);
}

function encodeVideoMessage(vid) {
  const parts = [];
  if (vid.url) parts.push(encodeBytes(1, Buffer.from(vid.url, 'utf8')));
  if (vid.mimetype) parts.push(encodeBytes(2, Buffer.from(vid.mimetype, 'utf8')));
  if (vid.fileSha256) parts.push(encodeBytes(3, toBuffer(vid.fileSha256)));
  if (vid.fileLength) parts.push(encodeVarint(4, vid.fileLength));
  if (vid.seconds) parts.push(encodeVarint(5, vid.seconds));
  if (vid.mediaKey) parts.push(encodeBytes(6, toBuffer(vid.mediaKey)));
  if (vid.caption) parts.push(encodeBytes(7, Buffer.from(vid.caption, 'utf8')));
  if (vid.gifPlayback !== undefined) parts.push(encodeVarint(8, vid.gifPlayback ? 1 : 0));
  if (vid.fileEncSha256) parts.push(encodeBytes(9, toBuffer(vid.fileEncSha256)));
  if (vid.directPath) parts.push(encodeBytes(10, Buffer.from(vid.directPath, 'utf8')));
  if (vid.mediaKeyTimestamp) parts.push(encodeVarint(11, vid.mediaKeyTimestamp));
  if (vid.jpegThumbnail) parts.push(encodeBytes(16, toBuffer(vid.jpegThumbnail)));
  if (vid.contextInfo) parts.push(encodeBytes(17, encodeContextInfo(vid.contextInfo)));
  return Buffer.concat(parts);
}

function encodeStickerMessage(stk) {
  const parts = [];
  if (stk.url) parts.push(encodeBytes(1, Buffer.from(stk.url, 'utf8')));
  if (stk.fileSha256) parts.push(encodeBytes(2, toBuffer(stk.fileSha256)));
  if (stk.fileEncSha256) parts.push(encodeBytes(3, toBuffer(stk.fileEncSha256)));
  if (stk.mediaKey) parts.push(encodeBytes(4, toBuffer(stk.mediaKey)));
  if (stk.mimetype) parts.push(encodeBytes(5, Buffer.from(stk.mimetype, 'utf8')));
  if (stk.height) parts.push(encodeVarint(6, stk.height));
  if (stk.width) parts.push(encodeVarint(7, stk.width));
  if (stk.directPath) parts.push(encodeBytes(8, Buffer.from(stk.directPath, 'utf8')));
  if (stk.fileLength) parts.push(encodeVarint(9, stk.fileLength));
  if (stk.mediaKeyTimestamp) parts.push(encodeVarint(10, stk.mediaKeyTimestamp));
  if (stk.isAnimated !== undefined) parts.push(encodeVarint(12, stk.isAnimated ? 1 : 0));
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

const toBuffer = (v) => Buffer.isBuffer(v) ? v : Buffer.from(v || []);

/**
 * Decodifica bytes Protobuf em um objeto Message amigável.
 */
export function decodeMessage(buf) {
  if (!buf || !buf.length) return {};
  try {
    const unpadded = unpadRandomMax16(buf);
    const o = decodeGeneric(unpadded);
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

    if (o[3] && o[3][0]) {
      const img = decodeGeneric(o[3][0]);
      msg.imageMessage = {
        url: img[1] && img[1][0] ? img[1][0].toString('utf8') : '',
        mimetype: img[2] && img[2][0] ? img[2][0].toString('utf8') : '',
        caption: img[3] && img[3][0] ? img[3][0].toString('utf8') : '',
        fileSha256: img[4] && img[4][0] ? img[4][0] : undefined,
        fileLength: img[5] && img[5][0] ? img[5][0] : 0,
        height: img[6] && img[6][0] ? img[6][0] : 0,
        width: img[7] && img[7][0] ? img[7][0] : 0,
        mediaKey: img[8] && img[8][0] ? img[8][0] : undefined,
        fileEncSha256: img[9] && img[9][0] ? img[9][0] : undefined,
        directPath: img[11] && img[11][0] ? img[11][0].toString('utf8') : '',
        mediaKeyTimestamp: img[12] && img[12][0] ? img[12][0] : 0
      };
    }

    if (o[7] && o[7][0]) {
      const doc = decodeGeneric(o[7][0]);
      msg.documentMessage = {
        url: doc[1] && doc[1][0] ? doc[1][0].toString('utf8') : '',
        mimetype: doc[2] && doc[2][0] ? doc[2][0].toString('utf8') : '',
        title: doc[3] && doc[3][0] ? doc[3][0].toString('utf8') : '',
        fileSha256: doc[4] && doc[4][0] ? doc[4][0] : undefined,
        fileLength: doc[5] && doc[5][0] ? doc[5][0] : 0,
        pageCount: doc[6] && doc[6][0] ? doc[6][0] : 0,
        mediaKey: doc[7] && doc[7][0] ? doc[7][0] : undefined,
        fileName: doc[8] && doc[8][0] ? doc[8][0].toString('utf8') : '',
        fileEncSha256: doc[9] && doc[9][0] ? doc[9][0] : undefined,
        directPath: doc[10] && doc[10][0] ? doc[10][0].toString('utf8') : '',
        mediaKeyTimestamp: doc[11] && doc[11][0] ? doc[11][0] : 0
      };
    }

    if (o[8] && o[8][0]) {
      const aud = decodeGeneric(o[8][0]);
      msg.audioMessage = {
        url: aud[1] && aud[1][0] ? aud[1][0].toString('utf8') : '',
        mimetype: aud[2] && aud[2][0] ? aud[2][0].toString('utf8') : '',
        fileSha256: aud[3] && aud[3][0] ? aud[3][0] : undefined,
        fileLength: aud[4] && aud[4][0] ? aud[4][0] : 0,
        seconds: aud[5] && aud[5][0] ? aud[5][0] : 0,
        ptt: aud[6] && aud[6][0] === 1,
        mediaKey: aud[7] && aud[7][0] ? aud[7][0] : undefined,
        fileEncSha256: aud[8] && aud[8][0] ? aud[8][0] : undefined,
        directPath: aud[9] && aud[9][0] ? aud[9][0].toString('utf8') : '',
        mediaKeyTimestamp: aud[10] && aud[10][0] ? aud[10][0] : 0
      };
    }

    if (o[9] && o[9][0]) {
      const vid = decodeGeneric(o[9][0]);
      msg.videoMessage = {
        url: vid[1] && vid[1][0] ? vid[1][0].toString('utf8') : '',
        mimetype: vid[2] && vid[2][0] ? vid[2][0].toString('utf8') : '',
        fileSha256: vid[3] && vid[3][0] ? vid[3][0] : undefined,
        fileLength: vid[4] && vid[4][0] ? vid[4][0] : 0,
        seconds: vid[5] && vid[5][0] ? vid[5][0] : 0,
        mediaKey: vid[6] && vid[6][0] ? vid[6][0] : undefined,
        caption: vid[7] && vid[7][0] ? vid[7][0].toString('utf8') : '',
        gifPlayback: vid[8] && vid[8][0] === 1,
        fileEncSha256: vid[9] && vid[9][0] ? vid[9][0] : undefined,
        directPath: vid[10] && vid[10][0] ? vid[10][0].toString('utf8') : '',
        mediaKeyTimestamp: vid[11] && vid[11][0] ? vid[11][0] : 0
      };
    }

    if (o[26] && o[26][0]) {
      const stk = decodeGeneric(o[26][0]);
      msg.stickerMessage = {
        url: stk[1] && stk[1][0] ? stk[1][0].toString('utf8') : '',
        fileSha256: stk[2] && stk[2][0] ? stk[2][0] : undefined,
        fileEncSha256: stk[3] && stk[3][0] ? stk[3][0] : undefined,
        mediaKey: stk[4] && stk[4][0] ? stk[4][0] : undefined,
        mimetype: stk[5] && stk[5][0] ? stk[5][0].toString('utf8') : '',
        height: stk[6] && stk[6][0] ? stk[6][0] : 0,
        width: stk[7] && stk[7][0] ? stk[7][0] : 0,
        directPath: stk[8] && stk[8][0] ? stk[8][0].toString('utf8') : '',
        fileLength: stk[9] && stk[9][0] ? stk[9][0] : 0,
        mediaKeyTimestamp: stk[10] && stk[10][0] ? stk[10][0] : 0,
        isAnimated: stk[12] && stk[12][0] === 1
      };
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
