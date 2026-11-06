/**
 * TcpTransport — ILocalTransport over TCP localhost.
 * Universal fallback: works on Linux, macOS, Windows without special paths.
 */

import net from 'node:net';
import { NdjsonFramer, writeNdjson } from './ndjson-framer.js';
import type { ILocalTransport } from './transport.js';

export class TcpTransport implements ILocalTransport {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private messageHandler: ((msg: unknown) => void) | null = null;

  constructor(
    private readonly port: number,
    private readonly host = '127.0.0.1',
  ) {}

  async listen(): Promise<void> {
    this.server = net.createServer((conn) => this.handleConnection(conn));
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, this.host, resolve);
      this.server!.once('error', reject);
    });
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket = net.createConnection(this.port, this.host, resolve);
      this.socket.once('error', reject);
      this.setupSocket(this.socket);
    });
  }

  send(msg: unknown): void {
    if (this.socket) { writeNdjson(this.socket, msg); }
  }

  onMessage(handler: (msg: unknown) => void): void {
    this.messageHandler = handler;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.server?.close();
    this.server = null;
  }

  private handleConnection(conn: net.Socket): void {
    this.socket = conn;
    this.setupSocket(conn);
  }

  private setupSocket(socket: net.Socket): void {
    const framer = new NdjsonFramer((msg) => this.messageHandler?.(msg));
    socket.on('data', (chunk) => {
      if (!framer.feed(socket, chunk)) { socket.destroy(); }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => { framer.reset(); });
  }
}
