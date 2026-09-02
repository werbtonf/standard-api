import { EventEmitter } from 'node:events';
import { WASocket } from './ws.js';
import { makeNoiseHandler } from '../crypto/noise.js';
import { Curve, randomBytes } from '../crypto/crypto.js';
import { encodeBinaryNode, decodeBinaryNode } from '../binary/wabinary.js';
import { encodeHandshakeMessage, decodeHandshakeMessage, encodeADVSignedDeviceIdentity } from '../binary/proto.js';
import { signPreKeys, normalizeCreds, buildRegistrationPayload, buildLoginPayload, buildPairingQRData } from '../pairing/auth.js';
import { configureSuccessfulPairing } from '../pairing/pairing.js';
import {
  makeSignalRepository,
  fetchPreKeys,
  usyncUser,
  jidDecode,
  checkWhatsAppNumber,
  checkWhatsAppNumbers,
  fetchProfilePictureUrl,
  fetchContactStatus,
  updateBlockStatus,
  fetchBlocklist,
  updateProfileStatus
} from '../crypto/signal.js';
import { encodeMessage, decodeMessage } from '../../services/message.service.js';
import { prepareMediaMessage } from '../../services/media.service.js';
import { logger } from '../../utils/logger.js';
import {
  WA_WS_URL,
  CONNECT_TIMEOUT_MS,
  KEEP_ALIVE_INTERVAL_MS,
  S_WHATSAPP_NET
} from '../../config/constants.js';
const COMPANION_REG_REFRESH_CHILDREN = ['companion_reg_refresh', 'pair-device-rotate-qr'];

let messageIdCounter = 0;
export const generateMessageTag = () => `${Date.now()}-${++messageIdCounter}`;

export function buildAckStanza(node, errorCode, meId) {
  const { tag, attrs } = node;
  const stanza = {
    tag: 'ack',
    attrs: {
      id: attrs.id,
      to: attrs.from || S_WHATSAPP_NET,
      class: tag
    }
  };
  if (attrs.type) stanza.attrs.type = attrs.type;
  if (attrs.participant) stanza.attrs.participant = attrs.participant;
  if (attrs.recipient) stanza.attrs.recipient = attrs.recipient;
  if (errorCode) stanza.attrs.error = String(errorCode);
  if (tag === 'message' && meId) stanza.attrs.from = meId;
  return stanza;
}

const normalizeJid = (j) => {
  let str = String(j).trim();
  if (!str.includes('@')) str += '@s.whatsapp.net';
  return str;
};

/**
 * Cliente WhatsApp não-oficial, implementado do zero.
 */
export async function connectWA(options = {}) {
  const {
    creds,
    browser = ['Ubuntu', 'Chrome', '22.04.4'],
    pushName = 'stdwpp',
    version = [2, 3000, 1043857760],
    waWebSocketUrl = WA_WS_URL,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    keepAliveIntervalMs = KEEP_ALIVE_INTERVAL_MS,
    printQRInTerminal = false
  } = options;

  const ev = new EventEmitter();
  ev.setMaxListeners(0);

  if (creds) {
    normalizeCreds(creds);
  }

  if (creds && !creds.signedPreKey?.signature) {
    await signPreKeys(creds);
  }

  const signalRepo = makeSignalRepository(creds, ev);

  let conn = null;

  const connectOnce = async (currentCreds) => {
    const ephemeralKeyPair = await Curve.generateKeyPair();
    const noiseKeyPair = currentCreds.noiseKey;
    const noise = makeNoiseHandler({
      keyPair: ephemeralKeyPair,
      routingInfo: currentCreds?.routingInfo
    });
    let connectUrl = waWebSocketUrl;
    if (currentCreds?.routingInfo) {
      const u = new URL(connectUrl);
      if (!u.searchParams.has('ED')) {
        u.searchParams.set('ED', Buffer.isBuffer(currentCreds.routingInfo) ? currentCreds.routingInfo.toString('base64url') : currentCreds.routingInfo);
      }
      connectUrl = u.toString();
    }
    const sock = new WASocket(connectUrl, { noise });

    let isAuthenticated = false;
    let keepAliveReq;
    let pairResolve;
    const queries = new Map();
    let lastDateRecv = Date.now();

    const startKeepAlive = () => {
      if (keepAliveReq) return;
      keepAliveReq = setInterval(() => {
        if (!sock.isOpen) return;
        const diff = Date.now() - lastDateRecv;
        if (diff > keepAliveIntervalMs + 15000) {
          console.warn(`[keepAlive] Conexao inativa ha ${Math.round(diff / 1000)}s. Reconectando...`);
          clearInterval(keepAliveReq);
          keepAliveReq = null;
          reconnect();
          return;
        }
        query({ tag: 'iq', attrs: { id: generateMessageTag(), to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:p' }, content: [{ tag: 'ping', attrs: {} }] }).catch(() => {});
      }, keepAliveIntervalMs);
    };

    const query = (node, timeoutMs = 15000) => {
      if (!node.attrs.id) node.attrs.id = generateMessageTag();
      const msgId = node.attrs.id;
      const buff = encodeBinaryNode(node);
      console.log(`[QUERY SEND ${msgId}] tag=${node.tag} xmlns=${node.attrs.xmlns} to=${node.attrs.to}`);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          queries.delete(msgId);
          console.log(`[QUERY TIMEOUT ${msgId}] after ${timeoutMs}ms`);
          reject(new Error('timed out waiting for ' + msgId));
        }, timeoutMs);
        queries.set(msgId, { resolve, reject, timeout });
        sock.sendRaw(buff).catch((err) => {
          clearTimeout(timeout);
          queries.delete(msgId);
          reject(err);
        });
      });
    };

    // --- fluxo de pareamento ---
    let currentQRRef = null;
    let refreshQR = () => {};
    let qrTimer = null;

    const handleCompanionRegRefresh = (node) => {
      const hasValidChild = COMPANION_REG_REFRESH_CHILDREN.some((tag) => getBinaryNodeChild(node, tag));
      if (!hasValidChild) return;
      if (currentCreds?.me) return;
      currentCreds.advSecretKey = randomBytes(32).toString('base64');
      ev.emit('creds.update', { advSecretKey: currentCreds.advSecretKey });
      refreshQR();
    };

    const handlePairDevice = async (node) => {
      try {
        const iq = { tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'result', id: node.attrs.id } };
        await sock.sendNode(iq);
        const pairDeviceNode = getBinaryNodeChild(node, 'pair-device');
        const refNodes = getBinaryNodeChildren(pairDeviceNode, 'ref');
        const refs = refNodes.map((r) => r.content.toString('utf-8'));
        let idx = 0;

        const renderQR = (ref) => {
          currentQRRef = ref;
          const qr = buildPairingQRData(ref, currentCreds, browser);
          ev.emit('connection.update', { qr });
        };

        refreshQR = () => {
          if (currentQRRef) renderQR(currentQRRef);
        };

        if (qrTimer) clearTimeout(qrTimer);

        let qrMs = 60000;
        const genPairQR = () => {
          const ref = refs[idx++];
          if (!ref) {
            ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Error('QR refs attempts ended') } });
            return;
          }
          renderQR(ref);
          qrTimer = setTimeout(genPairQR, qrMs);
          qrMs = 20000;
        };
        genPairQR();
      } catch (e) {
        logger.error('pairing', 'Falha ao processar nós do pair-device:', e);
        ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: e } });
      }
    };

    const handlePairSuccess = async (node) => {
      try {
        if (qrTimer) clearTimeout(qrTimer);
        const { reply, creds: newCreds } = await configureSuccessfulPairing(node, {
          advSecretKey: currentCreds.advSecretKey,
          signedIdentityKey: currentCreds.signedIdentityKey
        });
        Object.assign(currentCreds, newCreds);
        ev.emit('creds.update', newCreds);
        ev.emit('connection.update', { isNewLogin: true, qr: undefined });
        await sock.sendNode(reply);
        if (pairResolve) pairResolve(currentCreds);
      } catch (e) {
        logger.error('pairing', 'Falha ao validar assinaturas ADV de pareamento:', e);
        ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: e } });
      }
    };

    const emitNode = (node) => {
      if (node.attrs?.id && queries.has(node.attrs.id)) {
        console.log(`[QUERY MATCHED ${node.attrs.id}] tag=${node.tag} type=${node.attrs.type}`);
        const { resolve, reject, timeout } = queries.get(node.attrs.id);
        clearTimeout(timeout);
        queries.delete(node.attrs.id);
        if (node.tag === 'error' || node.attrs.type === 'error') {
          reject(new Error('query error: ' + JSON.stringify(node)));
        } else {
          resolve(node);
        }
        return;
      }
      if (node.tag === 'iq') {
        console.log(`[UNMATCHED IQ] id=${node.attrs?.id} type=${node.attrs?.type} from=${node.attrs?.from}`);
      }

      switch (node.tag) {
        case 'success':
          isAuthenticated = true;
          ev.emit('connection.update', { connection: 'open' });
          startKeepAlive();
          query({
            tag: 'iq',
            attrs: {
              to: S_WHATSAPP_NET,
              xmlns: 'passive',
              type: 'set'
            },
            content: [{ tag: 'active', attrs: {} }]
          }).catch((err) => console.warn('[passive active fail]', err.message));
          break;
        case 'failure':
          const failReason = node.attrs.reason || 'unknown';
          const isFailLoggedOut = ['401', '403', '405', 'logged_out'].includes(String(failReason));
          ev.emit('connection.update', {
            connection: 'close',
            isLoggedOut: isFailLoggedOut,
            lastDisconnect: { error: new Error('auth failure: ' + failReason) }
          });
          break;
        case 'stream:error':
          const errCode = String(node.attrs.code || '');
          const isStreamLoggedOut = ['401', '403', '405'].includes(errCode) ||
            (node.content || []).some(c => c && (c.tag === 'conflict' || c.tag === 'logged_out'));
          ev.emit('connection.update', {
            connection: 'close',
            isLoggedOut: isStreamLoggedOut,
            lastDisconnect: { error: new Error('stream error: ' + JSON.stringify(node)) }
          });
          break;
        case 'ib':
          ev.emit('ib', node);
          const edgeRoutingNode = getBinaryNodeChild(node, 'edge_routing');
          if (edgeRoutingNode) {
            const routingInfoNode = getBinaryNodeChild(edgeRoutingNode, 'routing_info');
            if (routingInfoNode && Buffer.isBuffer(routingInfoNode.content)) {
              currentCreds.routingInfo = routingInfoNode.content;
              ev.emit('creds.update', { routingInfo: currentCreds.routingInfo });
            }
          }
          break;
        case 'notification':
          ev.emit('notification', node);
          if (node.attrs.id) {
            sock.sendNode(buildAckStanza(node, undefined, currentCreds?.me?.id)).catch(() => {});
          }
          if (node.attrs.type === 'companion_reg_refresh') {
            handleCompanionRegRefresh(node);
          }
          break;
        case 'iq':
          ev.emit('iq', node);
          if (getBinaryNodeChild(node, 'pair-device')) {
            handlePairDevice(node);
          }
          if (getBinaryNodeChild(node, 'pair-success')) {
            handlePairSuccess(node);
          }
          break;
        case 'receipt':
          ev.emit('receipts.update', [node]);
          break;
        case 'message':
          (async () => {
            try {
              const from = node.attrs.from;
              const participant = node.attrs.participant;
              const senderJid = participant || from;
              const encNode = getBinaryNodeChild(node, 'enc');
              let decodedMsg = null;

              if (encNode && Buffer.isBuffer(encNode.content)) {
                const encType = encNode.attrs.type;
                try {
                  const decrypted = await signalRepo.decryptMessage({
                    jid: senderJid,
                    type: encType,
                    ciphertext: encNode.content
                  });
                  decodedMsg = decodeMessage(decrypted);
                } catch (err) {
                  console.error('[message decrypt fail]', err.message);
                  decodedMsg = { rawError: err.message };
                }
              }

              if (node.attrs.id) {
                const receiptNode = {
                  tag: 'receipt',
                  attrs: {
                    id: node.attrs.id,
                    to: from
                  }
                };
                if (participant) receiptNode.attrs.participant = participant;
                sock.sendNode(receiptNode).catch(() => {});
              }

              const msgInfo = {
                key: {
                  remoteJid: from,
                  fromMe: false,
                  id: node.attrs.id,
                  participant
                },
                message: decodedMsg,
                messageTimestamp: +node.attrs.t || Math.floor(Date.now() / 1000)
              };

              ev.emit('messages.upsert', { messages: [msgInfo], type: 'notify' });
              ev.emit('message', msgInfo);
            } catch (e) {
              console.error('[message handler fail]', e.message);
            }
          })();
          break;
        case 'presence':
          ev.emit('presence.update', [node]);
          break;
        case 'chatstate':
          ev.emit('chatstate.update', node);
          break;
        case 'action':
          ev.emit('action', node);
          break;
        default:
          ev.emit('node', node);
      }
    };

    sock.connect();
    await new Promise((resolve, reject) => {
      sock.once('open', resolve);
      sock.once('error', reject);
    });

    const helloMsg = encodeHandshakeMessage({
      clientHello: { ephemeral: ephemeralKeyPair.public }
    });
    await sock.sendRaw(helloMsg);

    const serverHelloFrame = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout serverHello')), connectTimeoutMs);
      sock.once('frame', (buf) => { clearTimeout(t); resolve(buf); });
    });

    const { serverHello } = decodeHandshakeMessage(serverHelloFrame);
    if (!serverHello) throw new Error('no serverHello received');

    const keyEnc = await noise.processHandshake({ serverHello }, noiseKeyPair);

    let payload;
    if (currentCreds?.me) {
      payload = buildLoginPayload(currentCreds, { browser, pushName, version });
    } else {
      payload = await buildRegistrationPayload(currentCreds, { browser, version });
    }
    const payloadEnc = noise.encrypt(payload);
    const clientFinish = encodeHandshakeMessage({
      clientFinish: { static: keyEnc, payload: payloadEnc }
    });
    await sock.sendRaw(clientFinish);
    await noise.finishInit();

    sock.on('frame', (frameBuf) => {
      lastDateRecv = Date.now();
      (async () => {
        try {
          const node = await decodeBinaryNode(frameBuf);
          logger.stanza('RECV', node);
          emitNode(node);
        } catch (e) {
          logger.error('binary', 'Falha ao decodificar frame binario:', e);
          sock.emit('error', new Error('decode failed: ' + e.message));
        }
      })();
    });

    startKeepAlive();

    conn = { sock, noise, query, close: () => { clearInterval(keepAliveReq); if (qrTimer) clearTimeout(qrTimer); sock.close(); } };
    return conn;
  };

  let isReconnecting = false;
  const reconnect = async () => {
    if (isReconnecting) return;
    isReconnecting = true;
    try {
      if (conn?.sock) {
        try { conn.sock.close(); } catch (e) {}
      }
      ev.emit('connection.update', { connection: 'reconnecting' });
      await connectOnce(creds);
    } finally {
      isReconnecting = false;
    }
  };

  await connectOnce(creds);

  /**
   * Envia uma mensagem com criptografia Signal E2EE Multi-Device completa.
   */
  const sendMessage = async (jid, content, options = {}) => {
    const { jid: canonicalJid, devices } = await usyncUser(conn.query, jid);
    const messageBytes = encodeMessage(content);

    // Busca pré-chaves em lote para todos os dispositivos usando key-index quando necessário
    await fetchPreKeys(conn.query, devices, signalRepo);

    const participantNodes = [];
    let shouldIncludeDeviceIdentity = false;

    for (const dev of devices) {
      const deviceJid = dev.jid;
      const hasSess = await signalRepo.hasSession(deviceJid);
      if (!hasSess) {
        if (dev.id === 0) {
          try {
            await fetchPreKeys(conn.query, [dev], signalRepo);
          } catch (e) {}
        } else {
          continue;
        }
      }

      try {
        const enc = await signalRepo.encryptMessage({ jid: deviceJid, data: messageBytes });
        if (enc.type === 'pkmsg') {
          shouldIncludeDeviceIdentity = true;
        }
        participantNodes.push({
          tag: 'to',
          attrs: { jid: deviceJid },
          content: [
            {
              tag: 'enc',
              attrs: {
                v: '2',
                type: enc.type
              },
              content: enc.ciphertext
            }
          ]
        });
      } catch (err) {
        console.warn(`[signal] falha ao cifrar para ${deviceJid}:`, err.message);
      }
    }

    if (participantNodes.length === 0) {
      throw new Error('Falha ao cifrar mensagem para os dispositivos do destinatário.');
    }

    const msgId = options.id || generateMessageTag();

    const messageNode = {
      tag: 'message',
      attrs: {
        id: msgId,
        to: canonicalJid,
        type: 'text'
      },
      content: [
        {
          tag: 'participants',
          attrs: {},
          content: participantNodes
        }
      ]
    };

    if (shouldIncludeDeviceIdentity && creds.account) {
      const deviceIdentityBuf = encodeADVSignedDeviceIdentity(creds.account);
      if (deviceIdentityBuf) {
        messageNode.content.push({
          tag: 'device-identity',
          attrs: {},
          content: deviceIdentityBuf
        });
      }
    }

    await conn.sock.sendNode(messageNode);

    return {
      key: {
        remoteJid: canonicalJid,
        fromMe: true,
        id: msgId
      },
      message: typeof content === 'string' ? { conversation: content } : content,
      messageTimestamp: Math.floor(Date.now() / 1000),
      status: 'PENDING'
    };
  };

  const sendMedia = async (jid, mediaOptions, options = {}) => {
    const mediaContent = await prepareMediaMessage(conn.query, mediaOptions);
    return await sendMessage(jid, mediaContent, options);
  };

  const sendReceipt = async (jid, participant, messageIds, type = 'read') => {
    const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
    const targetJid = normalizeJid(jid);
    for (const id of ids) {
      const node = {
        tag: 'receipt',
        attrs: {
          id,
          to: targetJid,
          type
        }
      };
      if (participant) node.attrs.participant = participant;
      await conn.sock.sendNode(node);
    }
  };

  const logout = async () => {
    const jid = currentCreds?.me?.id;
    if (jid && conn?.query) {
      try {
        console.log('[logout] Solicitando desvinculacao da conta ao WhatsApp:', jid);
        await conn.query({
          tag: 'iq',
          attrs: {
            to: S_WHATSAPP_NET,
            type: 'set',
            id: generateMessageTag(),
            xmlns: 'md'
          },
          content: [
            {
              tag: 'remove-companion-device',
              attrs: {
                jid,
                reason: 'user_initiated'
              }
            }
          ]
        }, 5000);
        console.log('[logout] Desvinculacao confirmada pelo servidor do WhatsApp.');
      } catch (e) {
        console.warn('[logout error]', e.message);
      }
    }
    if (conn) conn.close();
  };

  return {
    ev,
    get sock() { return conn.sock; },
    query: (node, timeout) => conn.query(node, timeout),
    sendNode: (node) => conn.sock.sendNode(node),
    sendMessage,
    sendMedia,
    sendReceipt,
    checkNumber: (number) => checkWhatsAppNumber(conn.query, number),
    checkNumbers: (numbers) => checkWhatsAppNumbers(conn.query, numbers),
    profilePictureUrl: (jidOrNumber, type) => fetchProfilePictureUrl(conn.query, jidOrNumber, type),
    fetchStatus: (jidOrNumber) => fetchContactStatus(conn.query, jidOrNumber),
    updateBlockStatus: (jidOrNumber, action) => updateBlockStatus(conn.query, jidOrNumber, action),
    fetchBlocklist: () => fetchBlocklist(conn.query),
    updateProfileStatus: (statusText) => updateProfileStatus(conn.query, statusText),
    logout,
    signal: signalRepo,
    close: () => conn.close()
  };
}

export const getBinaryNodeChild = (node, tag) => {
  if (!node.content || !Array.isArray(node.content)) return null;
  return node.content.find((c) => c && c.tag === tag) || null;
};

export const getBinaryNodeChildren = (node, tag) => {
  if (!node.content || !Array.isArray(node.content)) return [];
  return node.content.filter((c) => c && c.tag === tag);
};
