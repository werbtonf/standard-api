// Teste do handshake Noise contra o servidor real.
// Faz: connect -> clientHello -> serverHello -> clientFinish
// Sem creds, o servidor vai rejeitar o ClientPayload, mas isso prova
// que o handshake de transporte funciona.
import { WASocket } from '../src/ws.js';
import { makeNoiseHandler } from '../src/noise.js';
import { Curve } from '../src/crypto.js';
import { encodeHandshakeMessage, decodeHandshakeMessage, encodeClientPayload } from '../src/proto.js';
import { WA_WS_URL } from '../src/constants.js';

const ephemeralKeyPair = await Curve.generateKeyPair();
const noiseKeyPair = await Curve.generateKeyPair();

const noise = makeNoiseHandler({ keyPair: ephemeralKeyPair });
const sock = new WASocket(WA_WS_URL, { noise });

let stage = 0;
sock.on('error', (e) => console.log('[ws error]', e.message));
sock.on('close', (c, r) => console.log('[ws close]', c, r));

sock.connect();

await new Promise((resolve, reject) => {
  sock.once('open', resolve);
  sock.once('error', reject);
});
console.log('[1] WebSocket aberto');

// clientHello
const helloMsg = encodeHandshakeMessage({
  clientHello: { ephemeral: ephemeralKeyPair.public }
});
await sock.sendRaw(helloMsg);
console.log('[2] clientHello enviado');

// aguarda o serverHello (primeiro frame)
const serverHelloBuf = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout serverHello')), 15000);
  sock.once('frame', (buf) => { clearTimeout(t); resolve(buf); });
});
console.log('[3] serverHello recebido,', serverHelloBuf.length, 'bytes');

const { serverHello } = decodeHandshakeMessage(serverHelloBuf);
console.log('[4] ephemeral:', serverHello.ephemeral.toString('hex').slice(0, 20) + '...');
console.log('[4] static len:', serverHello.static.length, 'payload len:', serverHello.payload.length);

try {
  const keyEnc = await noise.processHandshake({ serverHello }, noiseKeyPair);
  console.log('[5] certificado validado, keyEnc pronto');

  const payload = {
    passive: true,
    pull: true,
    userAgent: { appVersion: { primary: 2, secondary: 3000, tertiary: 1043857760 }, platform: 0, releaseChannel: 0, mcc: 0, mnc: 0, osVersion: '', manufacturer: 'Chrome', device: 'Chrome (Linux)', osBuildNumber: '' },
    webInfo: { webSubPlatform: 0, webConfigVersion: 0 },
    pushName: 'stdwpp-test',
    connectType: 1,
    connectReason: 1,
    username: 0,
    device: 0,
    lidDbMigrated: false
  };
  const payloadEnc = noise.encrypt(encodeClientPayload(payload));
  const clientFinish = encodeHandshakeMessage({ clientFinish: { static: keyEnc, payload: payloadEnc } });
  await sock.sendRaw(clientFinish);
  console.log('[6] clientFinish enviado');

  await noise.finishInit();
  console.log('[7] transporte ativo (finishInit)');

  // aguarda próximo frame (deve vir descriptografado)
  const next = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout frame pós-handshake')), 15000);
    sock.once('frame', (buf) => { clearTimeout(t); resolve(buf); });
  });
  console.log('[8] frame pós-handshake:', next.length, 'bytes, hex:', next.toString('hex').slice(0, 80));
} catch (e) {
  console.error('[x] erro no handshake:', e.message);
  console.error(e.stack?.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
}

sock.close();
process.exit(0);
