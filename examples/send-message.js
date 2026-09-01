import { connectWA } from '../src/client.js';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

const SESSION_FILE = '/tmp/wa-api-session.json';

const targetNumber = process.argv[2];
const textMessage = process.argv[3] || 'Olá! Mensagem enviada via standard-api (Noise + Signal E2EE) 🚀';

if (!targetNumber) {
  console.log('Uso: node examples/send-message.js <numero-com-ddd-e-ddi> [mensagem]');
  console.log('Exemplo: node examples/send-message.js 5511999999999 "Olá mundo!"');
  process.exit(1);
}

if (!existsSync(SESSION_FILE)) {
  console.error('Nenhuma sessão pareada encontrada em', SESSION_FILE);
  console.error('Execute "node examples/register.js" primeiro para parear o WhatsApp.');
  process.exit(1);
}

const creds = JSON.parse(await readFile(SESSION_FILE, 'utf8'));
if (!creds.me) {
  console.error('A sessão em', SESSION_FILE, 'ainda não está pareada com um número.');
  process.exit(1);
}

console.log('Iniciando conexão como', creds.me.id, '...');

const client = await connectWA({
  creds,
  browser: ['Ubuntu', 'Chrome', '22.04.4'],
  pushName: 'standard-api'
});

let isSaving = false;
let queuedSave = false;
const saveCredsSafe = async () => {
  if (isSaving) { queuedSave = true; return; }
  isSaving = true;
  try {
    await writeFile(SESSION_FILE, JSON.stringify(creds, null, 2));
  } finally {
    isSaving = false;
    if (queuedSave) {
      queuedSave = false;
      saveCredsSafe();
    }
  }
};

client.ev.on('creds.update', saveCredsSafe);

client.ev.on('connection.update', async (update) => {
  if (update.connection === 'open') {
    console.log('Conectado com sucesso ao WhatsApp!');
    try {
      console.log(`Enviando mensagem para ${targetNumber}...`);
      const sent = await client.sendMessage(targetNumber, { text: textMessage });
      console.log('Mensagem enviada com sucesso!', sent);
    } catch (e) {
      console.error('Erro ao enviar mensagem:', e.message);
    } finally {
      setTimeout(() => {
        client.close();
        process.exit(0);
      }, 3000);
    }
  }
});
