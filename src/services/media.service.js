import { randomBytes, sha256, hmac, hkdf, aesEncryptCBC, aesDecryptCBC } from '../core/crypto/crypto.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

const MEDIA_HKDF_KEY_MAPPING = {
  image: 'Image',
  audio: 'Audio',
  document: 'Document',
  video: 'Video',
  sticker: 'Image'
};

const MEDIA_PATH_MAP = {
  image: '/mms/image',
  audio: '/mms/audio',
  document: '/mms/document',
  video: '/mms/video',
  sticker: '/mms/image'
};

const S_WHATSAPP_NET = '@s.whatsapp.net';

export const getMediaKeys = (mediaKey, mediaType) => {
  const hkdfInfo = MEDIA_HKDF_KEY_MAPPING[mediaType] || 'Image';
  const expanded = hkdf(mediaKey, 112, { info: Buffer.from(`WhatsApp ${hkdfInfo} Keys`, 'utf8') });
  return {
    iv: expanded.subarray(0, 16),
    cipherKey: expanded.subarray(16, 48),
    macKey: expanded.subarray(48, 80),
    refKey: expanded.subarray(80, 112)
  };
};

/**
 * Cifra um buffer de mídia de acordo com o protocolo do WhatsApp.
 */
export function encryptMedia(rawBuffer, mediaType) {
  const mediaKey = randomBytes(32);
  const { iv, cipherKey, macKey } = getMediaKeys(mediaKey, mediaType);

  const enc = aesEncryptCBC(rawBuffer, cipherKey, iv);
  const mac = hmac(macKey, Buffer.concat([iv, enc])).subarray(0, 10);
  const fileEnc = Buffer.concat([enc, mac]);

  const fileSha256 = sha256(rawBuffer);
  const fileEncSha256 = sha256(fileEnc);

  return {
    mediaKey,
    fileEnc,
    fileSha256,
    fileEncSha256,
    fileLength: rawBuffer.length
  };
}

/**
 * Decifra um buffer de mídia recebido do WhatsApp.
 */
export function decryptMedia(fileEncBuffer, mediaKey, mediaType) {
  const { iv, cipherKey, macKey } = getMediaKeys(mediaKey, mediaType);
  const enc = fileEncBuffer.subarray(0, fileEncBuffer.length - 10);
  const receivedMac = fileEncBuffer.subarray(fileEncBuffer.length - 10);

  const expectedMac = hmac(macKey, Buffer.concat([iv, enc])).subarray(0, 10);
  if (!receivedMac.equals(expectedMac)) {
    throw new Error('Falha na validação de integridade do arquivo (MAC inválido).');
  }

  return aesDecryptCBC(enc, cipherKey, iv);
}

let cachedMediaConn = null;

/**
 * Obtém os hosts e credenciais de upload da CDN do WhatsApp com persistência em disco.
 */
export async function getMediaConn(query, sessionDir = './sessions/default', forceRefresh = false) {
  const mediaConnFile = join(sessionDir, 'media_conn.json');

  // 1. Tenta carregar do cache em memória
  if (cachedMediaConn && !forceRefresh && (Date.now() - cachedMediaConn.fetchDate < cachedMediaConn.ttl * 1000)) {
    return cachedMediaConn;
  }

  // 2. Tenta carregar do arquivo em disco
  if (!forceRefresh && existsSync(mediaConnFile)) {
    try {
      const data = JSON.parse(readFileSync(mediaConnFile, 'utf8'));
      if (data && data.auth && (Date.now() - data.fetchDate < (data.ttl || 604800) * 1000)) {
        cachedMediaConn = data;
        return data;
      }
    } catch (e) {}
  }

  // 3. Consulta o WhatsApp se necessário
  try {
    const res = await query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:m' },
      content: [{ tag: 'media_conn', attrs: {} }]
    }, 8000);

    const mediaConnNode = (res.content || []).find(c => c && c.tag === 'media_conn');
    if (mediaConnNode && mediaConnNode.attrs && mediaConnNode.attrs.auth) {
      const hosts = (mediaConnNode.content || [])
        .filter(c => c && c.tag === 'host')
        .map(h => ({
          hostname: h.attrs.hostname,
          maxContentLengthBytes: +h.attrs.maxContentLengthBytes || 100 * 1024 * 1024
        }));

      cachedMediaConn = {
        auth: mediaConnNode.attrs.auth,
        ttl: +mediaConnNode.attrs.ttl || 604800,
        hosts: hosts.length > 0 ? hosts : [{ hostname: 'mmg.whatsapp.net' }, { hostname: 'mms.whatsapp.net' }],
        fetchDate: Date.now()
      };

      try {
        writeFileSync(mediaConnFile, JSON.stringify(cachedMediaConn, null, 2));
      } catch (e) {}

      return cachedMediaConn;
    }
  } catch (err) {
    console.warn('[getMediaConn] Falha na consulta de media_conn, utilizando fallback:', err.message);
  }

  // 4. Fallback padrão com hosts conhecidos
  if (cachedMediaConn) return cachedMediaConn;

  return {
    auth: '',
    ttl: 604800,
    hosts: [{ hostname: 'mmg.whatsapp.net' }, { hostname: 'mms.whatsapp.net' }],
    fetchDate: Date.now()
  };
}

/**
 * Faz upload do arquivo cifrado para a CDN do WhatsApp.
 */
export async function uploadMediaToWhatsApp(query, fileEncBuffer, { mediaType, fileEncSha256, sessionDir }) {
  const mediaConn = await getMediaConn(query, sessionDir);
  const pathPrefix = MEDIA_PATH_MAP[mediaType] || '/mms/image';
  const fileEncSha256B64Url = fileEncSha256.toString('base64url');

  for (const host of mediaConn.hosts) {
    const auth = mediaConn.auth ? encodeURIComponent(mediaConn.auth) : '';
    const authParam = auth ? `auth=${auth}&` : '';
    const urlStr = `https://${host.hostname}${pathPrefix}/${fileEncSha256B64Url}?${authParam}token=${fileEncSha256B64Url}`;
    
    try {
      const result = await postBinaryPayload(urlStr, fileEncBuffer);
      if (result && (result.url || result.direct_path)) {
        return {
          url: result.url || `https://${host.hostname}${result.direct_path}`,
          directPath: result.direct_path
        };
      }
    } catch (e) {
      // Tenta o próximo host
    }
  }

  throw new Error('Falha ao realizar upload da mídia para a CDN do WhatsApp.');
}

function postBinaryPayload(urlStr, buffer, timeoutMs = 25000) {
  const parsed = new URL(urlStr);
  const isHttps = parsed.protocol === 'https:';
  const client = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Origin': 'https://web.whatsapp.com',
        'Content-Length': buffer.length
      },
      timeout: timeoutMs
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout no upload da mídia'));
    });

    req.write(buffer);
    req.end();
  });
}

/**
 * Converte input (URL, base64 data URL ou buffer) em Buffer de bytes puro.
 */
export async function getMediaBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  const str = String(input).trim();

  if (str.startsWith('data:')) {
    const comma = str.indexOf(',');
    const b64 = comma !== -1 ? str.slice(comma + 1) : str;
    return Buffer.from(b64, 'base64');
  }

  if (str.startsWith('http://') || str.startsWith('https://')) {
    const res = await fetch(str);
    if (!res.ok) throw new Error(`Falha ao baixar arquivo da URL (${res.status}): ${str}`);
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  // Se for uma string base64 pura
  if (/^[A-Za-z0-9+/=]+$/.test(str) && str.length > 100) {
    return Buffer.from(str, 'base64');
  }

  throw new Error('Formato de mídia não suportado. Envie uma URL pública http/https ou uma string Base64 (data:mimetype;base64,...)');
}

/**
 * Baixa e decifra uma mídia recebida (CDN do WhatsApp + Media Cipher).
 * msgFields: url/directPath, mediaKey, fileEncSha256, fileSha256.
 * Retorna { buffer, mimetype, fileLength, mediaType } ou lança erro.
 */
export async function downloadReceivedMedia(msgFields, mediaType, { maxBytes = 100 * 1024 * 1024 } = {}) {
  const url = msgFields.url || (msgFields.directPath ? `https://mmg.whatsapp.net${msgFields.directPath}` : '');
  if (!url) throw new Error('Mídia sem URL/directPath para download.');

  const mediaKey = msgFields.mediaKey;
  if (!mediaKey) throw new Error('Mídia sem mediaKey para decifrar.');

  const keyBuf = Buffer.isBuffer(mediaKey) ? mediaKey : Buffer.from(mediaKey);
  const fileEncShaBuf = msgFields.fileEncSha256 ? (Buffer.isBuffer(msgFields.fileEncSha256) ? msgFields.fileEncSha256 : Buffer.from(msgFields.fileEncSha256)) : null;
  const fileShaBuf = msgFields.fileSha256 ? (Buffer.isBuffer(msgFields.fileSha256) ? msgFields.fileSha256 : Buffer.from(msgFields.fileSha256)) : null;

  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Download da mídia falhou (HTTP ${res.status})`);
  const encBuffer = Buffer.from(await res.arrayBuffer());

  if (fileEncShaBuf && !sha256(encBuffer).equals(fileEncShaBuf)) {
    throw new Error('Integridade do arquivo cifrado falhou (fileEncSha256).');
  }
  if (encBuffer.length > maxBytes) throw new Error(`Mídia excede ${maxBytes} bytes.`);

  const plainBuffer = decryptMedia(encBuffer, keyBuf, mediaType);

  if (fileShaBuf && !sha256(plainBuffer).equals(fileShaBuf)) {
    throw new Error('Integridade do conteúdo falhou (fileSha256).');
  }

  return {
    buffer: plainBuffer,
    mediaType,
    mimetype: msgFields.mimetype || 'application/octet-stream',
    fileLength: plainBuffer.length,
    filename: msgFields.fileName || msgFields.title || null,
    ptt: Boolean(msgFields.ptt),
    seconds: Number(msgFields.seconds || 0),
    caption: msgFields.caption || ''
  };
}

export const RECEIVED_MEDIA_TYPES = new Set(['image', 'audio', 'document', 'video', 'sticker']);

/**
 * Identifica o tipo de mídia de um Message já decodificado (plain).
 */
export function getReceivedMediaInfo(decodedMessage) {
  if (!decodedMessage) return null;
  for (const type of ['imageMessage', 'audioMessage', 'documentMessage', 'videoMessage', 'stickerMessage']) {
    const fields = decodedMessage[type];
    if (fields) {
      const shortType = type.replace('Message', '');
      if (!shortType || !RECEIVED_MEDIA_TYPES.has(shortType)) return null;
      return { shortType, fields };
    }
  }
  return null;
}

/**
 * Prepara o objeto Message do WhatsApp com os metadados e upload completos.
 */
export async function prepareMediaMessage(query, { media, type, caption, fileName, mimetype, ptt, seconds, sessionDir }) {
  const rawBuffer = await getMediaBuffer(media);
  const encResult = encryptMedia(rawBuffer, type);
  const uploadResult = await uploadMediaToWhatsApp(query, encResult.fileEnc, {
    mediaType: type,
    fileEncSha256: encResult.fileEncSha256,
    sessionDir
  });

  const timestamp = Math.floor(Date.now() / 1000);

  switch (type) {
    case 'image':
      return {
        imageMessage: {
          url: uploadResult.url,
          mimetype: mimetype || 'image/jpeg',
          caption: caption || '',
          fileSha256: encResult.fileSha256,
          fileLength: encResult.fileLength,
          mediaKey: encResult.mediaKey,
          fileEncSha256: encResult.fileEncSha256,
          directPath: uploadResult.directPath,
          mediaKeyTimestamp: timestamp
        }
      };

    case 'audio':
      return {
        audioMessage: {
          url: uploadResult.url,
          mimetype: mimetype || (ptt ? 'audio/ogg; codecs=opus' : 'audio/mp4'),
          fileSha256: encResult.fileSha256,
          fileLength: encResult.fileLength,
          seconds: seconds || 0,
          ptt: Boolean(ptt),
          mediaKey: encResult.mediaKey,
          fileEncSha256: encResult.fileEncSha256,
          directPath: uploadResult.directPath,
          mediaKeyTimestamp: timestamp
        }
      };

    case 'document':
      return {
        documentMessage: {
          url: uploadResult.url,
          mimetype: mimetype || 'application/pdf',
          title: fileName || 'document.pdf',
          fileName: fileName || 'document.pdf',
          fileSha256: encResult.fileSha256,
          fileLength: encResult.fileLength,
          mediaKey: encResult.mediaKey,
          fileEncSha256: encResult.fileEncSha256,
          directPath: uploadResult.directPath,
          mediaKeyTimestamp: timestamp
        }
      };

    case 'video':
      return {
        videoMessage: {
          url: uploadResult.url,
          mimetype: mimetype || 'video/mp4',
          caption: caption || '',
          fileSha256: encResult.fileSha256,
          fileLength: encResult.fileLength,
          seconds: seconds || 0,
          mediaKey: encResult.mediaKey,
          fileEncSha256: encResult.fileEncSha256,
          directPath: uploadResult.directPath,
          mediaKeyTimestamp: timestamp
        }
      };

    case 'sticker':
      return {
        stickerMessage: {
          url: uploadResult.url,
          mimetype: 'image/webp',
          fileSha256: encResult.fileSha256,
          fileLength: encResult.fileLength,
          mediaKey: encResult.mediaKey,
          fileEncSha256: encResult.fileEncSha256,
          directPath: uploadResult.directPath,
          mediaKeyTimestamp: timestamp
        }
      };

    default:
      throw new Error(`Tipo de mídia "${type}" não suportado. Use: image, audio, document, video ou sticker.`);
  }
}
