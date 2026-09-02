import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { encodeBinaryNode } from './wabinary.js';

/**
 * Wrapper do WebSocket do WhatsApp.
 * - Conecta em wss://web.whatsapp.com/ws/chat com Origin correta
 * - Encoda frames via noise.encodeFrame
 * - Decoda frames via noise.decodeFrame (buffering parcial)
 * - Emite evento "frame" com os buffers decodificados
 */
export class WASocket extends EventEmitter {
  constructor(url, { noise, headers = {}, handshakeTimeout = 30000 } = {}) {
    super();
    this.url = url;
    this.noise = noise;
    this.headers = headers;
    this.handshakeTimeout = handshakeTimeout;
    this.ws = null;
    this.isOpen = false;
  }

  connect() {
    this.ws = new WebSocket(this.url, {
      origin: 'https://web.whatsapp.com',
      headers: this.headers,
      handshakeTimeout: this.handshakeTimeout,
      maxPayload: 256 * 1024 * 1024
    });

    this.ws.on('open', () => {
      this.isOpen = true;
      this.emit('open');
    });

    this.ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      try {
        this.noise.decodeFrame(buf, (frame) => {
          this.emit('frame', frame);
        });
      } catch (e) {
        console.error('[ws] decodeFrame error:', e.message);
        this.emit('error', e);
      }
    });

    this.ws.on('close', (code, reason) => {
      this.isOpen = false;
      this.emit('close', code, reason?.toString());
    });

    this.ws.on('error', (err) => this.emit('error', err));

    return this;
  }

  /** Envia um buffer cru (já enquadrado via noise.encodeFrame). */
  sendRaw(data) {
    if (!this.isOpen) throw new Error('Connection Closed');
    const bytes = this.noise.encodeFrame(data);
    return new Promise((resolve, reject) => {
      this.ws.send(bytes, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Envia um node binário (encode + frame). */
  sendNode(node) {
    return this.sendRaw(encodeBinaryNode(node));
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}
