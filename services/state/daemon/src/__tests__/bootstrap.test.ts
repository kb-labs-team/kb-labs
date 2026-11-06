/**
 * Tests for bootstrap configuration — verifies port/host resolution from env vars,
 * server construction, socket support, and manifest correctness.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateDaemonServer } from '../server.js';
import { manifest } from '../manifest.js';

describe('StateDaemonServer construction', () => {
  it('creates server with custom port and host', () => {
    const server = new StateDaemonServer({ port: 9999, host: '0.0.0.0' });
    expect(server).toBeDefined();
    // No start() — just verify construction works
  });

  it('creates server with default config', () => {
    const server = new StateDaemonServer();
    expect(server).toBeDefined();
  });

  it('requires an assigned port before starting', async () => {
    await expect(new StateDaemonServer().start()).rejects.toThrow('KB_STATE_DAEMON_PORT');
  });

  it('creates server with custom logger', () => {
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      debug: () => {},
      trace: () => {},
      child: () => logger,
    } as any;

    const server = new StateDaemonServer({ logger });
    expect(server).toBeDefined();
  });
});

describe('StateDaemonServer socket support', () => {
  const origSocketPath = process.env.KB_SOCKET_PATH;

  afterEach(async () => {
    if (origSocketPath === undefined) {
      delete process.env.KB_SOCKET_PATH;
    } else {
      process.env.KB_SOCKET_PATH = origSocketPath;
    }
  });

  it('listens on Unix socket when KB_SOCKET_PATH is set', async () => {
    const sockPath = join(tmpdir(), `kb-test-state-${Date.now()}.sock`);
    process.env.KB_SOCKET_PATH = sockPath;

    const server = new StateDaemonServer({ port: 9998, host: 'localhost' });
    await server.start();
    try {
      expect(existsSync(sockPath)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('listens on TCP port when KB_SOCKET_PATH is not set', async () => {
    delete process.env.KB_SOCKET_PATH;
    const server = new StateDaemonServer({ port: 9997, host: '127.0.0.1' });
    await server.start();
    try {
      // Verify TCP is reachable
      const res = await fetch('http://127.0.0.1:9997/health');
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
    }
  });
});

describe('manifest', () => {
  it('has correct schema and id', () => {
    expect(manifest.schema).toBe('kb.service/1');
    expect(manifest.id).toBe('state-daemon');
  });

  it('does not declare a default host service port', () => {
    expect(manifest.runtime.port).toBeUndefined();
    expect(manifest.env?.KB_STATE_DAEMON_PORT?.default).toBeUndefined();
  });

  it('specifies health check endpoint', () => {
    expect(manifest.runtime.healthCheck).toBe('/health');
  });

  it('has entry point defined', () => {
    expect(manifest.runtime.entry).toBeDefined();
  });
});
