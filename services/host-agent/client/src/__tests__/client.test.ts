import { describe, it, expect, afterEach } from 'vitest';
import { TcpTransport } from '@kb-labs/host-agent-transport';
import { HostAgentClient } from '../client.js';

function randomPort(): number {
  return 41000 + Math.floor(Math.random() * 5000);
}

/** Minimal stub daemon: listens on TcpTransport, responds to IPC messages */
class StubDaemon {
  private transport: TcpTransport;

  constructor(port: number) {
    this.transport = new TcpTransport(port);
  }

  async start(): Promise<void> {
    this.transport.onMessage((msg) => this.handleMessage(msg));
    await this.transport.listen();
  }

  stop(): void { this.transport.close(); }

  private handleMessage(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) { return; }
    const m = msg as Record<string, unknown>;

    if (m['type'] === 'status') {
      this.transport.send({
        type: 'status',
        connected: true,
        hostId: 'host-123',
        gatewayUrl: 'https://gw.example.com',
        reconnecting: false,
      });
    } else if (m['type'] === 'execute') {
      const requestId = m['requestId'];
      this.transport.send({ type: 'event', requestId, data: { step: 1 } });
      this.transport.send({ type: 'event', requestId, data: { step: 2 } });
      this.transport.send({ type: 'done', requestId, result: { ok: true } });
    }
  }
}

describe('HostAgentClient', () => {
  let daemon: StubDaemon | null = null;
  let client: HostAgentClient | null = null;

  afterEach(() => {
    client?.close();
    daemon?.stop();
    client = null;
    daemon = null;
  });

  it('status() returns daemon status', async () => {
    const port = randomPort();
    daemon = new StubDaemon(port);
    await daemon.start();

    client = new HostAgentClient({
      transport: new TcpTransport(port),
    });
    await client.connect();

    const status = await client.status();
    expect(status).toMatchObject({
      connected: true,
      hostId: 'host-123',
    });
  });

  it('execute() streams events and resolves on done', async () => {
    const port = randomPort();
    daemon = new StubDaemon(port);
    await daemon.start();

    client = new HostAgentClient({
      transport: new TcpTransport(port),
    });
    await client.connect();

    const events: unknown[] = [];
    for await (const event of client.execute('workflow:run', { workflowId: 'x' })) {
      events.push(event);
    }

    expect(events).toEqual([{ step: 1 }, { step: 2 }]);
  });

  it('execute() throws on error response', async () => {
    const port = randomPort();
    const errTransport = new TcpTransport(port);
    const errDaemonTransport = new TcpTransport(port);

    errDaemonTransport.onMessage((msg) => {
      const m = msg as Record<string, unknown>;
      if (m['type'] === 'execute') {
        errDaemonTransport.send({
          type: 'error',
          requestId: m['requestId'],
          message: 'something went wrong',
        });
      }
    });
    await errDaemonTransport.listen();

    client = new HostAgentClient({ transport: errTransport });
    await client.connect();

    await expect(async () => {
       
      for await (const _ of client!.execute('bad:command')) { /* drain */ }
    }).rejects.toThrow('something went wrong');

    errDaemonTransport.close();
  });

  it('status() rejects on timeout', async () => {
    const port = randomPort();
    // Start a server that never responds
    const silentTransport = new TcpTransport(port);
    silentTransport.onMessage(() => { /* intentionally silent */ });
    await silentTransport.listen();

    client = new HostAgentClient({
      transport: new TcpTransport(port),
      requestTimeout: 100,
    });
    await client.connect();

    await expect(client.status()).rejects.toThrow('timed out');
    silentTransport.close();
  });
});
