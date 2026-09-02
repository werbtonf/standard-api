import { connectWA } from '../src/core/transport/client.js';
import { initAuthCreds, signPreKeys } from '../src/core/pairing/auth.js';
import { existsSync } from 'node:fs';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import QRCode from 'qrcode';

const SESSION_FILE = '/tmp/wa-api-session.json';
const QR_FILE = '/tmp/wa-api-qr.png';
const LOG_FILE = '/tmp/wa-api-debug.log';

const log = async (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { await appendFile(LOG_FILE, line); } catch (e) {}
  console.log(msg);
};

let creds;
if (existsSync(SESSION_FILE)) {
  creds = JSON.parse(await readFile(SESSION_FILE, 'utf8'));
  await log('Sessão existente: ' + (creds.me?.id || 'não pareado'));
} else {
  creds = initAuthCreds();
  creds = await signPreKeys(creds);
  await writeFile(SESSION_FILE, JSON.stringify(creds, null, 2));
  await log('Nova identidade gerada e salva');
}

let client = null;

async function showQR(qr) {
  const terminalQR = await QRCode.toString(qr, { type: 'terminal', small: true });
  console.log('\n' + terminalQR + '\n');
  await writeFile(QR_FILE, await QRCode.toBuffer(qr, { type: 'png', width: 400, margin: 2 }));
  await log('QR salvo em ' + QR_FILE);
}

async function setupClient() {
  await log('connectWA...');
  client = await connectWA({
    creds,
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    pushName: 'stdwpp',
    printQRInTerminal: true
  });
  await log('connectWA retornou');

  client.ev.on('connection.update', async (update) => {
    if (update.qr) {
      await showQR(update.qr);
    }
    await log('connection.update: ' + JSON.stringify(Object.keys(update)));
    if (update.isNewLogin) {
      await writeFile(SESSION_FILE, JSON.stringify(creds, null, 2));
      await log('Sessão pareada salva!');
    }
    if (update.connection === 'open') {
      await log('Conectado ao WhatsApp!');
      process.exit(0);
    }
  });

  client.ev.on('creds.update', async (u) => {
    await log('creds.update: ' + JSON.stringify(u).slice(0, 200));
  });

  client.ev.on('notification', async (n) => {
    await log('notification: type=' + n.attrs.type);
  });

  client.sock.on('error', (e) => log('[sock error] ' + e.message));
  client.sock.on('close', (c, r) => {
    log('[sock close] ' + c + ' ' + r + ' - reconectando em 3s');
    if (!creds?.me) setTimeout(setupClient, 3000);
  });
}

await setupClient();

process.on('unhandledRejection', (e) => log('[unhandledRejection] ' + (e?.message || e)));

// mantém vivo
setInterval(() => {}, 1000);
