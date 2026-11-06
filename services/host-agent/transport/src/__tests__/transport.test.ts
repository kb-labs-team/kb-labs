import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnixSocketTransport } from '../unix-socket.js';
import { TcpTransport } from '../tcp.js';
import { createTransport } from '../auto.js';

// Pick a random port to avoid conflicts
function randomPort(): number {
  return 40000 + Math.floor(Math.random() * 10000);
}

describe('TcpTransport', () => {
  let server: TcpTransport | null = null;
  let client: TcpTransport | null = null;

  afterEach(() => {
    server?.close();
    client?.close();
    server = null;
    client = null;
  });

  it('sends and receives a message round-trip', async () => {
    const port = randomPort();
    server = new TcpTransport(port);
    client = new TcpTransport(port);

    const received: unknown[] = [];
    server.onMessage((msg) => received.push(msg));

    await server.listen();
    await client.connect();

    client.send({ hello: 'world' });

    // Wait for message to arrive
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.length > 0) { clearInterval(check); resolve(); }
      }, 10);
    });

    expect(received[0]).toEqual({ hello: 'world' });
  });

  it('handles multiple messages in sequence', async () => {
    const port = randomPort();
    server = new TcpTransport(port);
    client = new TcpTransport(port);

    const received: unknown[] = [];
    server.onMessage((msg) => received.push(msg));

    await server.listen();
    await client.connect();

    client.send({ n: 1 });
    client.send({ n: 2 });
    client.send({ n: 3 });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.length >= 3) { clearInterval(check); resolve(); }
      }, 10);
    });

    expect(received).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});

describe('UnixSocketTransport', () => {
  let server: UnixSocketTransport | null = null;
  let client: UnixSocketTransport | null = null;

  afterEach(() => {
    server?.close();
    client?.close();
    server = null;
    client = null;
  });

  it('sends and receives a message round-trip', async () => {
    const socketPath = join(tmpdir(), `test-agent-${Math.random().toString(36).slice(2)}.sock`);
    server = new UnixSocketTransport(socketPath);
    client = new UnixSocketTransport(socketPath);

    const received: unknown[] = [];
    server.onMessage((msg) => received.push(msg));

    await server.listen();
    await client.connect();

    client.send({ type: 'status' });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.length > 0) { clearInterval(check); resolve(); }
      }, 10);
    });

    expect(received[0]).toEqual({ type: 'status' });
  });
});

describe('createTransport', () => {
  it('creates TcpTransport for mode=tcp', () => {
    const t = createTransport({ mode: 'tcp', port: 9999 });
    expect(t).toBeInstanceOf(TcpTransport);
  });

  it('creates platform-appropriate transport for mode=auto', async () => {
    const t = createTransport({ mode: 'auto' });
    if (process.platform === 'win32') {
      const { NamedPipeTransport } = await import('../named-pipe.js');
      expect(t).toBeInstanceOf(NamedPipeTransport);
    } else {
      expect(t).toBeInstanceOf(UnixSocketTransport);
    }
  });

  it('throws for unknown mode', () => {
    expect(() => createTransport({ mode: 'unknown' as never })).toThrow('Unknown transport mode');
  });
});
