// ANSI Color Codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgGreen: '\x1b[42m',
  bgBlue: '\x1b[44m',
  bgCyan: '\x1b[46m',
  bgYellow: '\x1b[43m',
  bgRed: '\x1b[41m'
};

const getTimestamp = () => {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${colors.gray}[${h}:${m}:${s}]${colors.reset}`;
};

const isDebug = process.env.DEBUG === 'true' || process.env.LOG_LEVEL === 'debug';
const isDebugStanza = process.env.DEBUG_STANZA === 'true';

export const logger = {
  banner(info = {}) {
    const line = `${colors.cyan}${colors.bold}================================================================================${colors.reset}`;
    console.log(`\n${line}`);
    console.log(`   ${colors.bold}${colors.white}STANDARD API${colors.reset} ${colors.gray}- WhatsApp Multi-Device & Multi-Tenant REST API v1.0.0${colors.reset}`);
    console.log(`${line}`);
    console.log(` ${colors.cyan}[SYSTEM]${colors.reset}   Porta HTTP:     ${colors.bold}${info.port || 3000}${colors.reset} (http://${info.host || 'localhost'}:${info.port || 3000})`);
    console.log(` ${colors.cyan}[SYSTEM]${colors.reset}   Swagger Docs:   ${colors.bold}http://${info.host || 'localhost'}:${info.port || 3000}/docs${colors.reset}`);
    console.log(` ${colors.cyan}[SYSTEM]${colors.reset}   PostgreSQL:     ${info.dbConnected ? colors.green + 'Conectado' : colors.yellow + 'Desabilitado / Local'}${colors.reset}`);
    console.log(` ${colors.cyan}[SYSTEM]${colors.reset}   Redis Cache:    ${info.redisConnected ? colors.green + 'Conectado' : colors.yellow + 'Desabilitado / Memoria'}${colors.reset}`);
    console.log(` ${colors.cyan}[SYSTEM]${colors.reset}   Seguranca:      ${info.hasApiKey ? colors.green + 'API Key Ativa (Autenticacao Obrigatoria)' : colors.yellow + 'Modo Desprotegido'}${colors.reset}`);
    console.log(`${line}\n`);
  },

  server(message) {
    console.log(`${getTimestamp()} ${colors.bold}${colors.cyan}[SERVER]${colors.reset} ${message}`);
  },

  instance(name, message) {
    console.log(`${getTimestamp()} ${colors.bold}${colors.blue}[INSTANCE:${name}]${colors.reset} ${message}`);
  },

  auth(name, message) {
    console.log(`${getTimestamp()} ${colors.bold}${colors.blue}[INSTANCE:${name}]${colors.reset} ${colors.bold}${colors.yellow}[AUTH]${colors.reset} ${message}`);
  },

  outgoing(name, message) {
    console.log(`${getTimestamp()} ${colors.bold}${colors.blue}[INSTANCE:${name}]${colors.reset} ${colors.bold}${colors.green}[OUTGOING]${colors.reset} ${message}`);
  },

  incoming(name, message) {
    console.log(`${getTimestamp()} ${colors.bold}${colors.blue}[INSTANCE:${name}]${colors.reset} ${colors.bold}${colors.magenta}[INCOMING]${colors.reset} ${message}`);
  },

  webhook(name, message) {
    console.log(`${getTimestamp()} ${colors.bold}${colors.blue}[INSTANCE:${name}]${colors.reset} ${colors.bold}${colors.yellow}[WEBHOOK]${colors.reset} ${message}`);
  },

  db(message) {
    console.log(`${getTimestamp()} ${colors.bold}${colors.blue}[DATABASE]${colors.reset} ${message}`);
  },

  redis(message) {
    console.log(`${getTimestamp()} ${colors.bold}${colors.magenta}[REDIS]${colors.reset} ${message}`);
  },

  warn(tag, message) {
    console.log(`${getTimestamp()} ${colors.bold}${colors.yellow}[WARN:${tag}]${colors.reset} ${message}`);
  },

  error(tag, message, err) {
    console.error(`${getTimestamp()} ${colors.bold}${colors.red}[ERROR:${tag}]${colors.reset} ${message}`, err?.message || err || '');
  },

  debug(tag, message) {
    if (isDebug) {
      console.log(`${getTimestamp()} ${colors.dim}[DEBUG:${tag}] ${message}${colors.reset}`);
    }
  },

  stanza(direction, node) {
    if (isDebugStanza) {
      console.log(`${getTimestamp()} ${colors.dim}[STANZA:${direction}] ${node.tag} ${JSON.stringify(node.attrs || {})}${colors.reset}`);
    }
  }
};
