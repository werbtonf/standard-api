// Encoder/decoder de protobuf minimalista (do zero, sem dependências)
// Suporta apenas o subconjunto necessário para o handshake do WhatsApp.

// --- primitivas de wire format ---

export const WIRE_VARINT = 0;
export const WIRE_64BIT = 1;
export const WIRE_LENGTH_DELIMITED = 2;
export const WIRE_32BIT = 5;

/** Decodifica um varint. Retorna { value, bytesRead }. */
export function readVarint(buf, pos = 0) {
  const start = pos;
  let result = 0;
  let shift = 0;
  let b;
  do {
    if (pos >= buf.length) throw new Error('varint overflow');
    b = buf[pos++];
    if (shift >= 64) throw new Error('varint too long');
    result += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return { value: result, bytesRead: pos - start };
}

/** Codifica um varint (número <= 2^53-1). */
export function writeVarint(value) {
  const out = [];
  let n = value;
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

/** Lê um campo protobuf: { field, wire, value, pos } */
export function readField(buf, pos = 0) {
  if (pos >= buf.length) return null;
  const { value: key, bytesRead: br } = readVarint(buf, pos);
  pos += br;
  const field = key >>> 3;
  const wire = key & 7;
  let value;
  if (wire === WIRE_VARINT) {
    const v = readVarint(buf, pos);
    value = v.value;
    pos += v.bytesRead;
  } else if (wire === WIRE_LENGTH_DELIMITED) {
    const len = readVarint(buf, pos);
    pos += len.bytesRead;
    value = buf.subarray(pos, pos + len.value);
    pos += len.value;
  } else if (wire === WIRE_64BIT) {
    value = buf.subarray(pos, pos + 8);
    pos += 8;
  } else if (wire === WIRE_32BIT) {
    value = buf.subarray(pos, pos + 4);
    pos += 4;
  } else {
    throw new Error('unsupported wire type: ' + wire);
  }
  return { field, wire, value, pos };
}

/** Decodifica um objeto genérico em { field: [values] } */
export function decodeGeneric(buf) {
  const obj = {};
  let pos = 0;
  while (pos < buf.length) {
    const f = readField(buf, pos);
    if (!f) break;
    pos = f.pos;
    if (!obj[f.field]) obj[f.field] = [];
    obj[f.field].push(f.value);
  }
  return obj;
}

const tag = (field, wire) => writeVarint((field << 3) | wire);

export function encodeBytes(field, buf) {
  return Buffer.concat([tag(field, WIRE_LENGTH_DELIMITED), writeVarint(buf.length), buf]);
}

export function encodeVarint(field, value) {
  return Buffer.concat([tag(field, WIRE_VARINT), writeVarint(value)]);
}

// --- HandshakeMessage ---

export function encodeHandshakeMessage(msg) {
  const parts = [];
  if (msg.clientHello) {
    const inner = [];
    if (msg.clientHello.ephemeral) inner.push(encodeBytes(1, msg.clientHello.ephemeral));
    if (msg.clientHello.static) inner.push(encodeBytes(2, msg.clientHello.static));
    if (msg.clientHello.payload) inner.push(encodeBytes(3, msg.clientHello.payload));
    parts.push(encodeBytes(2, Buffer.concat(inner)));
  }
  if (msg.serverHello) {
    const inner = [];
    if (msg.serverHello.ephemeral) inner.push(encodeBytes(1, msg.serverHello.ephemeral));
    if (msg.serverHello.static) inner.push(encodeBytes(2, msg.serverHello.static));
    if (msg.serverHello.payload) inner.push(encodeBytes(3, msg.serverHello.payload));
    if (msg.serverHello.extendedStatic) inner.push(encodeBytes(4, msg.serverHello.extendedStatic));
    parts.push(encodeBytes(3, Buffer.concat(inner)));
  }
  if (msg.clientFinish) {
    const inner = [];
    if (msg.clientFinish.static) inner.push(encodeBytes(1, msg.clientFinish.static));
    if (msg.clientFinish.payload) inner.push(encodeBytes(2, msg.clientFinish.payload));
    parts.push(encodeBytes(4, Buffer.concat(inner)));
  }
  return Buffer.concat(parts);
}

export function decodeHandshakeMessage(buf) {
  const o = decodeGeneric(buf);
  const out = {};
  if (o[2]) out.clientHello = decodeClientHello(o[2][0]);
  if (o[3]) out.serverHello = decodeServerHello(o[3][0]);
  if (o[4]) out.clientFinish = { static: o[4][0], payload: o[4][1], extendedCiphertext: o[4][2] };
  return out;
}

const decodeClientHello = (buf) => {
  const o = decodeGeneric(buf);
  return {
    ephemeral: o[1] && o[1][0],
    static: o[2] && o[2][0],
    payload: o[3] && o[3][0],
    useExtended: o[4] && o[4][0]
  };
};

const decodeServerHello = (buf) => {
  const o = decodeGeneric(buf);
  return {
    ephemeral: o[1] && o[1][0],
    static: o[2] && o[2][0],
    payload: o[3] && o[3][0],
    extendedStatic: o[4] && o[4][0]
  };
};

// --- CertChain (do serverHello.payload decifrado) ---

export function decodeCertChain(buf) {
  const o = decodeGeneric(buf);
  return {
    leaf: o[1] && decodeNoiseCertificate(o[1][0]),
    intermediate: o[2] && decodeNoiseCertificate(o[2][0])
  };
}

const decodeNoiseCertificate = (buf) => {
  const o = decodeGeneric(buf);
  return {
    details: o[1] && o[1][0],
    signature: o[2] && o[2][0]
  };
};

export function decodeNoiseCertDetails(buf) {
  const o = decodeGeneric(buf);
  return {
    serial: o[1] && o[1][0],
    issuerSerial: o[2] && o[2][0],
    key: o[3] && o[3][0],
    notBefore: o[4] && o[4][0],
    notAfter: o[5] && o[5][0]
  };
}

// --- ClientPayload (login) ---

export function encodeClientPayload(payload) {
  const parts = [];
  const { username, passive, userAgent, webInfo, pushName, sessionId, shortConnect,
    connectType, connectReason, device, devicePairingData, pull, lidDbMigrated, product } = payload;
  if (username !== undefined) parts.push(encodeVarint(1, username));
  if (passive !== undefined) parts.push(encodeVarint(3, passive ? 1 : 0));
  if (userAgent) parts.push(encodeBytes(5, encodeUserAgent(userAgent)));
  if (webInfo) parts.push(encodeBytes(6, encodeWebInfo(webInfo)));
  if (pushName !== undefined) parts.push(encodeBytes(7, Buffer.from(pushName, 'utf8')));
  if (sessionId !== undefined) parts.push(encodeVarint(9, sessionId));
  if (shortConnect !== undefined) parts.push(encodeVarint(10, shortConnect ? 1 : 0));
  if (connectType !== undefined) parts.push(encodeVarint(12, connectType));
  if (connectReason !== undefined) parts.push(encodeVarint(13, connectReason));
  if (device !== undefined) parts.push(encodeVarint(18, device));
  if (devicePairingData) parts.push(encodeBytes(19, encodeDevicePairingRegistrationData(devicePairingData)));
  if (product !== undefined) parts.push(encodeVarint(20, product));
  if (pull !== undefined) parts.push(encodeVarint(33, pull ? 1 : 0));
  if (lidDbMigrated !== undefined) parts.push(encodeVarint(41, lidDbMigrated ? 1 : 0));
  return Buffer.concat(parts);
}

export function decodeClientPayload(buf) {
  const o = decodeGeneric(buf);
  return {
    username: o[1] && o[1][0],
    passive: o[3] && o[3][0],
    userAgent: o[5] && decodeUserAgent(o[5][0]),
    webInfo: o[6] && decodeWebInfo(o[6][0]),
    pushName: o[7] && o[7][0].toString('utf8'),
    sessionId: o[9] && o[9][0],
    shortConnect: o[10] && o[10][0],
    connectType: o[12] && o[12][0],
    connectReason: o[13] && o[13][0],
    device: o[18] && o[18][0],
    product: o[20] && o[20][0],
    pull: o[33] && o[33][0],
    lidDbMigrated: o[41] && o[41][0]
  };
}

// --- UserAgent ---

const encodeUserAgent = (ua) => {
  const parts = [];
  if (ua.platform !== undefined) parts.push(encodeVarint(1, ua.platform));
  if (ua.appVersion) {
    const v = [];
    if (ua.appVersion.primary !== undefined) v.push(encodeVarint(1, ua.appVersion.primary));
    if (ua.appVersion.secondary !== undefined) v.push(encodeVarint(2, ua.appVersion.secondary));
    if (ua.appVersion.tertiary !== undefined) v.push(encodeVarint(3, ua.appVersion.tertiary));
    if (ua.appVersion.quaternary !== undefined) v.push(encodeVarint(4, ua.appVersion.quaternary));
    parts.push(encodeBytes(2, Buffer.concat(v)));
  }
  if (ua.mcc !== undefined) parts.push(encodeBytes(3, Buffer.from(String(ua.mcc), 'utf8')));
  if (ua.mnc !== undefined) parts.push(encodeBytes(4, Buffer.from(String(ua.mnc), 'utf8')));
  if (ua.osVersion !== undefined) parts.push(encodeBytes(5, Buffer.from(ua.osVersion, 'utf8')));
  if (ua.manufacturer !== undefined) parts.push(encodeBytes(6, Buffer.from(ua.manufacturer, 'utf8')));
  if (ua.device !== undefined) parts.push(encodeBytes(7, Buffer.from(ua.device, 'utf8')));
  if (ua.osBuildNumber !== undefined) parts.push(encodeBytes(8, Buffer.from(ua.osBuildNumber, 'utf8')));
  if (ua.phoneId !== undefined) parts.push(encodeBytes(9, Buffer.from(ua.phoneId, 'utf8')));
  if (ua.releaseChannel !== undefined) parts.push(encodeVarint(10, ua.releaseChannel));
  if (ua.localeLanguageIso6391 !== undefined) parts.push(encodeBytes(11, Buffer.from(ua.localeLanguageIso6391, 'utf8')));
  if (ua.localeCountryIso31661Alpha2 !== undefined) parts.push(encodeBytes(12, Buffer.from(ua.localeCountryIso31661Alpha2, 'utf8')));
  return Buffer.concat(parts);
};

const decodeUserAgent = (buf) => {
  const o = decodeGeneric(buf);
  const av = o[2] && decodeGeneric(o[2][0]);
  return {
    platform: o[1] && o[1][0],
    appVersion: av && {
      primary: av[1] && av[1][0],
      secondary: av[2] && av[2][0],
      tertiary: av[3] && av[3][0],
      quaternary: av[4] && av[4][0]
    },
    mcc: o[3] && o[3][0].toString('utf8'),
    mnc: o[4] && o[4][0].toString('utf8'),
    osVersion: o[5] && o[5][0].toString('utf8'),
    manufacturer: o[6] && o[6][0].toString('utf8'),
    device: o[7] && o[7][0].toString('utf8'),
    osBuildNumber: o[8] && o[8][0].toString('utf8'),
    phoneId: o[9] && o[9][0].toString('utf8'),
    releaseChannel: o[10] && o[10][0],
    localeLanguageIso6391: o[11] && o[11][0].toString('utf8'),
    localeCountryIso31661Alpha2: o[12] && o[12][0].toString('utf8')
  };
};

// --- WebInfo ---

const encodeWebInfo = (wi) => {
  const parts = [];
  if (wi.refToken !== undefined) parts.push(encodeBytes(1, Buffer.from(wi.refToken, 'utf8')));
  if (wi.version !== undefined) parts.push(encodeBytes(2, Buffer.from(wi.version, 'utf8')));
  if (wi.webdPayload) {
    const p = [];
    if (wi.webdPayload.webdPayloadId !== undefined) parts.push(encodeBytes(1, Buffer.from(String(wi.webdPayload.webdPayloadId), 'utf8')));
    if (wi.webdPayload.webdPayloadKey !== undefined) parts.push(encodeBytes(2, Buffer.from(wi.webdPayload.webdPayloadKey, 'utf8')));
    if (wi.webdPayload.webdPayloadVersion !== undefined) parts.push(encodeVarint(3, wi.webdPayload.webdPayloadVersion));
    parts.push(encodeBytes(3, Buffer.concat(p)));
  }
  if (wi.webSubPlatform !== undefined) parts.push(encodeVarint(4, wi.webSubPlatform));
  return Buffer.concat(parts);
};

const decodeWebInfo = (buf) => {
  const o = decodeGeneric(buf);
  return {
    webSubPlatform: o[1] && o[1][0],
    webConfigVersion: o[2] && o[2][0]
  };
};

// --- DevicePairingRegistrationData (registro) ---

export function encodeDevicePairingRegistrationData(data) {
  const parts = [];
  if (data.eRegid) parts.push(encodeBytes(1, data.eRegid));
  if (data.eKeytype) parts.push(encodeBytes(2, data.eKeytype));
  if (data.eIdent) parts.push(encodeBytes(3, data.eIdent));
  if (data.eSkeyId) parts.push(encodeBytes(4, data.eSkeyId));
  if (data.eSkeyVal) parts.push(encodeBytes(5, data.eSkeyVal));
  if (data.eSkeySig) parts.push(encodeBytes(6, data.eSkeySig));
  if (data.buildHash) parts.push(encodeBytes(7, data.buildHash));
  if (data.deviceProps) parts.push(encodeBytes(8, data.deviceProps));
  return Buffer.concat(parts);
}

// --- DeviceProps ---

export function encodeDeviceProps(props) {
  const parts = [];
  if (props.os !== undefined) parts.push(encodeBytes(1, Buffer.from(props.os, 'utf8')));
  if (props.version) {
    const v = [];
    if (props.version.primary !== undefined) v.push(encodeVarint(1, props.version.primary));
    if (props.version.secondary !== undefined) v.push(encodeVarint(2, props.version.secondary));
    if (props.version.tertiary !== undefined) v.push(encodeVarint(3, props.version.tertiary));
    if (props.version.quaternary !== undefined) v.push(encodeVarint(4, props.version.quaternary));
    parts.push(encodeBytes(2, Buffer.concat(v)));
  }
  if (props.platformType !== undefined) parts.push(encodeVarint(3, props.platformType));
  if (props.requireFullSync !== undefined) parts.push(encodeVarint(4, props.requireFullSync ? 1 : 0));
  if (props.historySyncConfig) parts.push(encodeBytes(5, encodeHistorySyncConfig(props.historySyncConfig)));
  return Buffer.concat(parts);
}

function encodeHistorySyncConfig(h) {
  const parts = [];
  if (h.storageQuotaMb !== undefined) parts.push(encodeVarint(3, h.storageQuotaMb));
  if (h.inlineInitialPayloadInE2EeMsg !== undefined) parts.push(encodeVarint(4, h.inlineInitialPayloadInE2EeMsg ? 1 : 0));
  if (h.supportCallLogHistory !== undefined) parts.push(encodeVarint(6, h.supportCallLogHistory ? 1 : 0));
  if (h.supportBotUserAgentChatHistory !== undefined) parts.push(encodeVarint(7, h.supportBotUserAgentChatHistory ? 1 : 0));
  if (h.supportCagReactionsAndPolls !== undefined) parts.push(encodeVarint(8, h.supportCagReactionsAndPolls ? 1 : 0));
  if (h.supportBizHostedMsg !== undefined) parts.push(encodeVarint(9, h.supportBizHostedMsg ? 1 : 0));
  if (h.supportRecentSyncChunkMessageCountTuning !== undefined) parts.push(encodeVarint(10, h.supportRecentSyncChunkMessageCountTuning ? 1 : 0));
  if (h.supportHostedGroupMsg !== undefined) parts.push(encodeVarint(11, h.supportHostedGroupMsg ? 1 : 0));
  if (h.supportFbidBotChatHistory !== undefined) parts.push(encodeVarint(12, h.supportFbidBotChatHistory ? 1 : 0));
  if (h.supportMessageAssociation !== undefined) parts.push(encodeVarint(14, h.supportMessageAssociation ? 1 : 0));
  if (h.supportGroupHistory !== undefined) parts.push(encodeVarint(15, h.supportGroupHistory ? 1 : 0));
  if (h.supportGuestChat !== undefined) parts.push(encodeVarint(17, h.supportGuestChat ? 1 : 0));
  return Buffer.concat(parts);
}

// --- ADVSignedDeviceIdentityHMAC / ADVSignedDeviceIdentity / ADVDeviceIdentity ---

export function decodeADVSignedDeviceIdentityHMAC(buf) {
  const o = decodeGeneric(buf);
  return {
    details: o[1] && o[1][0],
    hmac: o[2] && o[2][0],
    accountType: o[3] && o[3][0]
  };
}

export function decodeADVSignedDeviceIdentity(buf) {
  const o = decodeGeneric(buf);
  return {
    details: o[1] && o[1][0],
    accountSignatureKey: o[2] && o[2][0],
    accountSignature: o[3] && o[3][0],
    deviceSignature: o[4] && o[4][0]
  };
}

export function encodeADVSignedDeviceIdentity(acc) {
  const parts = [];
  if (acc.details) parts.push(encodeBytes(1, acc.details));
  if (acc.accountSignatureKey) parts.push(encodeBytes(2, acc.accountSignatureKey));
  if (acc.accountSignature) parts.push(encodeBytes(3, acc.accountSignature));
  if (acc.deviceSignature) parts.push(encodeBytes(4, acc.deviceSignature));
  return Buffer.concat(parts);
}

export function decodeADVDeviceIdentity(buf) {
  const o = decodeGeneric(buf);
  return {
    rawId: o[1] && o[1][0],
    timestamp: o[2] && o[2][0],
    keyIndex: o[3] && o[3][0],
    accountType: o[4] && o[4][0],
    deviceType: o[5] && o[5][0]
  };
}
