import fs from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { TAGS, DOUBLE_BYTE_TOKENS, SINGLE_BYTE_TOKENS } = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'tokens.json'), 'utf8')
);

// Mapa token -> { index, dict } para codificação
const TOKEN_MAP = {};
for (let i = 0; i < SINGLE_BYTE_TOKENS.length; i++) {
  TOKEN_MAP[SINGLE_BYTE_TOKENS[i]] = { index: i };
}
for (let i = 0; i < DOUBLE_BYTE_TOKENS.length; i++) {
  for (let j = 0; j < DOUBLE_BYTE_TOKENS[i].length; j++) {
    TOKEN_MAP[DOUBLE_BYTE_TOKENS[i][j]] = { dict: i, index: j };
  }
}

export { TAGS, DOUBLE_BYTE_TOKENS, SINGLE_BYTE_TOKENS, TOKEN_MAP };

/**
 * Decodifica um node binário do protocolo WhatsApp.
 * @param {Buffer} buffer (sem o byte de compressão)
 * @param {{index?: number}} indexRef
 */
export function decodeDecompressedBinaryNode(buffer, opts = {}, indexRef = { index: 0 }) {
  const { DOUBLE_BYTE_TOKENS: DBT = DOUBLE_BYTE_TOKENS, SINGLE_BYTE_TOKENS: SBT = SINGLE_BYTE_TOKENS, TAGS: T = TAGS } = opts;

  const checkEOS = (length) => {
    if (indexRef.index + length > buffer.length) throw new Error('end of stream');
  };
  const next = () => {
    const value = buffer[indexRef.index];
    indexRef.index += 1;
    return value;
  };
  const readByte = () => { checkEOS(1); return next(); };
  const readBytes = (n) => {
    checkEOS(n);
    const value = buffer.subarray(indexRef.index, indexRef.index + n);
    indexRef.index += n;
    return value;
  };
  const readStringFromChars = (length) => readBytes(length).toString('utf-8');
  const readInt = (n, littleEndian = false) => {
    checkEOS(n);
    let val = 0;
    for (let i = 0; i < n; i++) {
      const shift = littleEndian ? i : n - 1 - i;
      val |= next() << (shift * 8);
    }
    return val;
  };
  const readInt20 = () => {
    checkEOS(3);
    return ((next() & 15) << 16) + (next() << 8) + next();
  };
  const unpackHex = (value) => {
    if (value >= 0 && value < 16) {
      return value < 10 ? '0'.charCodeAt(0) + value : 'A'.charCodeAt(0) + value - 10;
    }
    throw new Error('invalid hex: ' + value);
  };
  const unpackNibble = (value) => {
    if (value >= 0 && value <= 9) return '0'.charCodeAt(0) + value;
    switch (value) {
      case 10: return '-'.charCodeAt(0);
      case 11: return '.'.charCodeAt(0);
      case 15: return '\0'.charCodeAt(0);
      default: throw new Error('invalid nibble: ' + value);
    }
  };
  const unpackByte = (tag, value) => {
    if (tag === T.NIBBLE_8) return unpackNibble(value);
    else if (tag === T.HEX_8) return unpackHex(value);
    else throw new Error('unknown tag: ' + tag);
  };
  const readPacked8 = (tag) => {
    const startByte = readByte();
    let value = '';
    for (let i = 0; i < (startByte & 127); i++) {
      const curByte = readByte();
      value += String.fromCharCode(unpackByte(tag, (curByte & 0xf0) >> 4));
      value += String.fromCharCode(unpackByte(tag, curByte & 0x0f));
    }
    if (startByte >> 7 !== 0) value = value.slice(0, -1);
    return value;
  };
  const isListTag = (tag) => tag === T.LIST_EMPTY || tag === T.LIST_8 || tag === T.LIST_16;
  const readListSize = (tag) => {
    switch (tag) {
      case T.LIST_EMPTY: return 0;
      case T.LIST_8: return readByte();
      case T.LIST_16: return readInt(2);
      default: throw new Error('invalid tag for list size: ' + tag);
    }
  };
  const readJidPair = () => {
    const i = readString(readByte());
    const j = readString(readByte());
    if (j) return (i || '') + '@' + j;
    throw new Error('invalid jid pair: ' + i + ', ' + j);
  };
  const readAdJid = () => {
    const domainType = readByte();
    const device = readByte();
    const user = readString(readByte());
    let server = 's.whatsapp.net';
    if (domainType === 1) server = 'lid';
    else if (domainType === 2) server = 'hosted';
    else if (domainType === 3) server = 'hosted.lid';
    return `${user}@${server}${device ? ':' + device : ''}`;
  };
  const readFbJid = () => {
    const user = readString(readByte());
    const device = readInt(2);
    const server = readString(readByte());
    return `${user}:${device}@${server}`;
  };
  const readInteropJid = () => {
    const user = readString(readByte());
    const device = readInt(2);
    const integrator = readInt(2);
    let server = 'interop';
    const beforeServer = indexRef.index;
    try { server = readString(readByte()); } catch (err) { indexRef.index = beforeServer; }
    return `${integrator}-${user}:${device}@${server}`;
  };
  const readString = (tag) => {
    if (tag >= 1 && tag < SBT.length) return SBT[tag] || '';
    switch (tag) {
      case T.DICTIONARY_0:
      case T.DICTIONARY_1:
      case T.DICTIONARY_2:
      case T.DICTIONARY_3:
        return getTokenDouble(tag - T.DICTIONARY_0, readByte());
      case T.LIST_EMPTY: return '';
      case T.BINARY_8: return readStringFromChars(readByte());
      case T.BINARY_20: return readStringFromChars(readInt20());
      case T.BINARY_32: return readStringFromChars(readInt(4));
      case T.JID_PAIR: return readJidPair();
      case T.FB_JID: return readFbJid();
      case T.INTEROP_JID: return readInteropJid();
      case T.AD_JID: return readAdJid();
      case T.HEX_8:
      case T.NIBBLE_8:
        return readPacked8(tag);
      default: throw new Error('invalid string with tag: ' + tag);
    }
  };
  const readList = (tag) => {
    const items = [];
    const size = readListSize(tag);
    for (let i = 0; i < size; i++) {
      items.push(decodeDecompressedBinaryNode(buffer, opts, indexRef));
    }
    return items;
  };
  const getTokenDouble = (index1, index2) => {
    const dict = DBT[index1];
    if (!dict) throw new Error(`Invalid double token dict (${index1})`);
    const value = dict[index2];
    if (typeof value === 'undefined') throw new Error(`Invalid double token (${index2})`);
    return value;
  };

  const listSize = readListSize(readByte());
  const header = readString(readByte());
  if (!listSize || !header.length) throw new Error('invalid node');

  const attrs = {};
  let data;
  const attributesLength = (listSize - 1) >> 1;
  for (let i = 0; i < attributesLength; i++) {
    const key = readString(readByte());
    const value = readString(readByte());
    attrs[key] = value;
  }
  if (listSize % 2 === 0) {
    const tag = readByte();
    if (isListTag(tag)) {
      data = readList(tag);
    } else {
      let decoded;
      switch (tag) {
        case T.BINARY_8: decoded = readBytes(readByte()); break;
        case T.BINARY_20: decoded = readBytes(readInt20()); break;
        case T.BINARY_32: decoded = readBytes(readInt(4)); break;
        default: decoded = readString(tag); break;
      }
      data = decoded;
    }
  }
  return { tag: header, attrs, content: data };
}

/** Remove prefixo de compressão e decodifica. */
export async function decodeBinaryNode(buff) {
  const decompBuff = decompressingIfRequired(buff);
  return decodeDecompressedBinaryNode(decompBuff);
}

/** Se o primeiro byte tem bit 2 setado, é inflate; senão remove o 0x00. */
export function decompressingIfRequired(buffer) {
  if (2 & buffer.readUInt8()) {
    return inflateSync(buffer.subarray(1));
  }
  return buffer.subarray(1);
}

/**
 * Codifica um node para o formato binário.
 * Buffer começa com 0x00 (sem compressão).
 */
export function encodeBinaryNode(node, opts = {}) {
  const { TAGS: T = TAGS, TOKEN_MAP: TM = TOKEN_MAP } = opts;
  const buffer = [0];

  const pushByte = (value) => buffer.push(value & 0xff);
  const pushInt = (value, n, littleEndian = false) => {
    for (let i = 0; i < n; i++) {
      const curShift = littleEndian ? i : n - 1 - i;
      buffer.push((value >> (curShift * 8)) & 0xff);
    }
  };
  const pushBytes = (bytes) => { for (const b of bytes) buffer.push(b); };
  const pushInt16 = (value) => pushBytes([(value >> 8) & 0xff, value & 0xff]);
  const pushInt20 = (value) => pushBytes([(value >> 16) & 0x0f, (value >> 8) & 0xff, value & 0xff]);

  const writeByteLength = (length) => {
    if (length >= 4294967296) throw new Error('string too large to encode: ' + length);
    if (length >= 1 << 20) { pushByte(T.BINARY_32); pushInt(length, 4); }
    else if (length >= 256) { pushByte(T.BINARY_20); pushInt20(length); }
    else { pushByte(T.BINARY_8); pushByte(length); }
  };
  const writeStringRaw = (str) => {
    const bytes = Buffer.from(str, 'utf-8');
    writeByteLength(bytes.length);
    pushBytes(bytes);
  };
  const writeJid = ({ domainType, device, user, server }) => {
    if (typeof device !== 'undefined') {
      pushByte(T.AD_JID);
      pushByte(domainType || 0);
      pushByte(device || 0);
      writeString(user);
    } else {
      pushByte(T.JID_PAIR);
      if (user.length) writeString(user);
      else pushByte(T.LIST_EMPTY);
      writeString(server);
    }
  };
  const packNibble = (char) => {
    switch (char) {
      case '-': return 10;
      case '.': return 11;
      case '\0': return 15;
      default:
        if (char >= '0' && char <= '9') return char.charCodeAt(0) - '0'.charCodeAt(0);
        throw new Error(`invalid byte for nibble "${char}"`);
    }
  };
  const packHex = (char) => {
    if (char >= '0' && char <= '9') return char.charCodeAt(0) - '0'.charCodeAt(0);
    if (char >= 'A' && char <= 'F') return 10 + char.charCodeAt(0) - 'A'.charCodeAt(0);
    if (char >= 'a' && char <= 'f') return 10 + char.charCodeAt(0) - 'a'.charCodeAt(0);
    if (char === '\0') return 15;
    throw new Error(`Invalid hex char "${char}"`);
  };
  const writePackedBytes = (str, type) => {
    if (str.length > T.PACKED_MAX) throw new Error('Too many bytes to pack');
    pushByte(type === 'nibble' ? T.NIBBLE_8 : T.HEX_8);
    let roundedLength = Math.ceil(str.length / 2.0);
    if (str.length % 2 !== 0) roundedLength |= 128;
    pushByte(roundedLength);
    const packFunction = type === 'nibble' ? packNibble : packHex;
    const packBytePair = (v1, v2) => (packFunction(v1) << 4) | packFunction(v2);
    const strLengthHalf = Math.floor(str.length / 2);
    for (let i = 0; i < strLengthHalf; i++) pushByte(packBytePair(str[2 * i], str[2 * i + 1]));
    if (str.length % 2 !== 0) pushByte(packBytePair(str[str.length - 1], '\x00'));
  };
  const isNibble = (str) => {
    if (!str || str.length > T.PACKED_MAX) return false;
    for (const char of str) {
      if (char < '0' || char > '9') {
        if (char !== '-' && char !== '.') return false;
      }
    }
    return true;
  };
  const isHex = (str) => {
    if (!str || str.length > T.PACKED_MAX) return false;
    for (const char of str) {
      if (char < '0' || char > '9') {
        if (!(char >= 'A' && char <= 'F')) return false;
      }
    }
    return true;
  };
  const writeString = (str) => {
    if (str === undefined || str === null) { pushByte(T.LIST_EMPTY); return; }
    if (str === '') { writeStringRaw(str); return; }
    const tokenIndex = TM[str];
    if (tokenIndex) {
      if (typeof tokenIndex.dict === 'number') pushByte(T.DICTIONARY_0 + tokenIndex.dict);
      pushByte(tokenIndex.index);
    } else if (isNibble(str)) {
      writePackedBytes(str, 'nibble');
    } else if (isHex(str)) {
      writePackedBytes(str, 'hex');
    } else {
      const decodedJid = jidDecode(str);
      if (decodedJid) writeJid(decodedJid);
      else writeStringRaw(str);
    }
  };
  const writeListStart = (listSize) => {
    if (listSize === 0) pushByte(T.LIST_EMPTY);
    else if (listSize < 256) pushBytes([T.LIST_8, listSize]);
    else { pushByte(T.LIST_16); pushInt16(listSize); }
  };

  const encodeInner = ({ tag, attrs, content }) => {
    if (!tag) throw new Error('Invalid node: tag cannot be undefined');
    const validAttributes = Object.keys(attrs || {}).filter(k => typeof attrs[k] !== 'undefined' && attrs[k] !== null);
    writeListStart(2 * validAttributes.length + 1 + (typeof content !== 'undefined' ? 1 : 0));
    writeString(tag);
    for (const key of validAttributes) {
      if (typeof attrs[key] === 'string') {
        writeString(key);
        writeString(attrs[key]);
      }
    }
    if (typeof content === 'string') {
      writeString(content);
    } else if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
      writeByteLength(content.length);
      pushBytes(content);
    } else if (Array.isArray(content)) {
      const validContent = content.filter(item => item && (item.tag || Buffer.isBuffer(item) || item instanceof Uint8Array || typeof item === 'string'));
      writeListStart(validContent.length);
      for (const item of validContent) encodeInner(item);
    } else if (typeof content === 'undefined') {
      // nada
    } else {
      throw new Error(`invalid children for header "${tag}": ${content}`);
    }
  };

  encodeInner(node);
  return Buffer.from(buffer);
}

/** Decodifica um JID "user@server[:device]" */
function jidDecode(jid) {
  if (typeof jid !== 'string' || !jid.includes('@')) return null;
  const idx = jid.lastIndexOf('@');
  const user = jid.slice(0, idx);
  let server = jid.slice(idx + 1);
  const colon = server.indexOf(':');
  let device;
  if (colon !== -1) {
    device = +server.slice(colon + 1);
    server = server.slice(0, colon);
  }
  if (user && server) {
    return { user, device, server };
  }
  return null;
}
