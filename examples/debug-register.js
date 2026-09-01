// Debug do fluxo completo de registro (handshake + ClientPayload de registro)
import { WASocket } from '../src/ws.js';
import { makeNoiseHandler } from '../src/noise.js';
import { Curve } from '../src/crypto.js';
import { encodeHandshakeMessage, decodeHandshakeMessage } from '../src/proto.js';
import { initAuthCreds, signPreKeys, buildRegistrationPayload } from '../src/auth.js';
import { writeFileSync } from 'node:fs';

let frames = 0;

const creds = initAuthCreds();
await signPreKeys(creds);

const ephemeralKeyPair = await Curve.generateKeyPair();
const noiseKeyPair = await Curve.generateKeyPair();
const noise = makeNoiseHandler({ keyPair: ephemeralKeyPair });
const sock = new WASocket('wss://web.whatsapp.com/ws/chat', { noise });

sock.on('open', () => console.log('[open]'));
sock.on('error', (e) => console.log('[err]', e.message));
sock.on('close', (c, r) => console.log('[close]', c, r));
sock.on('frame', (b) => {
  console.log('[frame]', b.length, 'bytes', b.slice(0, 12).toString('hex'));
  if (frames++ >= 1) {
    writeFileSync('/tmp/opencode/pairdev.bin', b);
    console.log('salvo frame', b.length);
  }
});
sock.connect();
await new Promise((r, j) => { sock.once('open', r); sock.once('error', j); });
console.log('sock aberto');

const helloMsg = encodeHandshakeMessage({ clientHello: { ephemeral: ephemeralKeyPair.public } });
await sock.sendRaw(helloMsg);
console.log('clientHello enviado');

const sh = await new Promise((r, j) => {
  const t = setTimeout(() => j(new Error('timeout serverHello')), 15000);
  sock.once('frame', (buf) => { clearTimeout(t); r(buf); });
});
console.log('serverHello:', sh.length, 'bytes');
const { serverHello } = decodeHandshakeMessage(sh);
const keyEnc = await noise.processHandshake({ serverHello }, noiseKeyPair);
console.log('certificado validado, keyEnc pronto');

const payload = await buildRegistrationPayload(creds, { browser: ['Ubuntu', 'Chrome', '22.04.4'], version: [2, 3000, 1043857760] });
console.log('payload registro:', payload.length, 'bytes');
const payloadEnc = noise.encrypt(payload);
const cf = encodeHandshakeMessage({ clientFinish: { static: keyEnc, payload: payloadEnc } });
await sock.sendRaw(cf);
await noise.finishInit();
console.log('clientFinish enviado, transporte ativo. Aguardando frames...');

setTimeout(() => process.exit(0), 15000);
