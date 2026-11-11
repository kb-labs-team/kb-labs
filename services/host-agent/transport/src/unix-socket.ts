/**
 * UnixSocketTransport — ILocalTransport over Unix domain socket.
 * Default on Linux/macOS.
 */

import net from 'node:net';
import { NdjsonFramer, writeNdjson } from './ndjson-framer.js';
import type { ILocalTransport } from './transport.js';

export class UnixSocketTransport implements ILocalTransport {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private messageHandler: ((msg: unknown) => void) | null = null;

  constructor(private readonly socketPath: string) {}

  async listen(): Promise<void> {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(this.socketPath);
    } catch { /* stale socket — fine */ }

    this.server = net.createServer((conn) => this.handleConnection(conn));
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.socketPath, resolve);
      this.server!.once('error', reject);
    });

    const { chmod } = await import('node:fs/promises');
    await chmod(this.socketPath, 0o600);
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket = net.createConnection(this.socketPath, resolve);
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
