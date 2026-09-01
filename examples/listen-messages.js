import { connectWA } from '../src/client.js';
import { initAuthCreds, signPreKeys } from '../src/auth.js';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import QRCode from 'qrcode';

const SESSION_FILE = '/tmp/wa-api-session.json';
const QR_FILE = '/tmp/wa-api-qr.png';

let creds;
if (existsSync(SESSION_FILE)) {
  creds = JSON.parse(await readFile(SESSION_FILE, 'utf8'));
  console.log('Carregando sessão existente:', creds.me?.id || 'não pareado');
} else {
  creds = initAuthCreds();
  creds = await signPreKeys(creds);
  await writeFile(SESSION_FILE, JSON.stringify(creds, null, 2));
  console.log('Nova identidade criada e salva');
}

const client = await connectWA({
  creds,
  browser: ['Ubuntu', 'Chrome', '22.04.4'],
  pushName: 'standard-api'
});

client.ev.on('creds.update', async () => {
  await writeFile(SESSION_FILE, JSON.stringify(creds, null, 2));
});

client.ev.on('connection.update', async (update) => {
  if (update.qr) {
    const terminalQR = await QRCode.toString(update.qr, { type: 'terminal', small: true });
    console.log('
' + terminalQR + '
');
    await writeFile(QR_FILE, await QRCode.toBuffer(update.qr, { type: 'png', width: 400, margin: 2 }));
    console.log('QR Code salvo em ' + QR_FILE);
  }

  if (update.connection === 'open') {
    console.log('🟢 standard-api online e ouvindo mensagens!');
  }
});

// Evento disparado para toda mensagem recebida e decifrada
client.ev.on('messages.upsert', ({ messages, type }) => {
  for (const m of messages) {
    const sender = m.key.remoteJid;
    const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '(mensagem não-texto ou vazia)';
    console.log(`
📩 [Mensagem de ${sender}]: ${text}`);
    if (m.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
      console.log('   ↳ Resposta a:', m.message.extendedTextMessage.contextInfo.quotedMessage);
    }
  }
});
