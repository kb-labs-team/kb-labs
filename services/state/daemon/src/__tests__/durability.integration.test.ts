import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ILogger } from '@kb-labs/core-platform';
import { createDurableStateDaemon } from '../server.js';

const activeServers: Array<{ stop(): Promise<void> }> = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.stop()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function makeLogger(records: Array<{ message: string; meta?: Record<string, unknown> }>): ILogger {
  const logger: ILogger = {
    info: () => {},
    warn: (message, meta) => records.push({ message, meta }),
    error: () => {},
    fatal: () => {},
    debug: () => {},
    trace: () => {},
    flush: async () => {},
    child: () => logger,
  };
  return logger;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kb-state-broker-durability-'));
  temporaryRoots.push(root);
  return root;
}

async function start(port: number, platformDataRoot: string, logger?: ILogger): Promise<{ stop(): Promise<void> }> {
  const server = createDurableStateDaemon({ port, host: '127.0.0.1', logger }, platformDataRoot);
  await server.start();
  activeServers.push(server);
  return server;
}

async function setValue(port: number, key: string, value: unknown, ttl?: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/state/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ttl === undefined ? { value } : { value, ttl }),
  });
}

async function getValue(port: number, key: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/state/${encodeURIComponent(key)}`);
}

describe('StateDaemon durability', () => {
  // case: S-280.8
  it('releases the durable broker after listener startup fails', async () => {
    const root = await makeRoot();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('listener blocker has no TCP port');
    const failed = createDurableStateDaemon({ port: address.port, host: '127.0.0.1' }, root);

    await expect(failed.start()).rejects.toThrow();
    await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));

    await start(address.port, root);
    const ready = await fetch(`http://127.0.0.1:${address.port}/ready`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ ready: true, status: 'ready' });
  });

  it('restores a successfully written value after daemon restart', async () => {
    const root = await makeRoot();
    const port = 9878;
    await start(port, root);
    const written = await setValue(port, 'round-trip', { answer: 42 }, 60_000);
    expect(written.status).toBe(204);
    await activeServers.pop()?.stop();

    await start(port, root);
    const response = await getValue(port, 'round-trip');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ answer: 42 });
  });

  it('uses persisted wall-clock expiry after host restart and retains the omitted-TTL default', async () => {
    const root = await makeRoot();
    const port = 9879;
    await start(port, root);
    expect((await setValue(port, 'unexpired', 'kept', 60_000)).status).toBe(204);
    expect((await setValue(port, 'expired', 'gone', 25)).status).toBe(204);
    expect((await setValue(port, 'default-ttl', 'default')).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await activeServers.pop()?.stop();

    await start(port, root);
    expect((await getValue(port, 'unexpired')).status).toBe(200);
    expect((await getValue(port, 'expired')).status).toBe(404);
    expect((await getValue(port, 'default-ttl')).status).toBe(200);
  });

  it('keeps only the prefix before a malformed complete record and reports the catalogue code', async () => {
    const root = await makeRoot();
    const port = 9880;
    const records: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    await start(port, root, makeLogger(records));
    expect((await setValue(port, 'verified-prefix', 'kept', 60_000)).status).toBe(204);
    expect((await setValue(port, 'after-corruption', 'not recovered', 60_000)).status).toBe(204);
    await activeServers.pop()?.stop();

    const journal = path.join(root, 'state-broker', 'journal.jsonl');
    const validRecords = await readFile(journal, 'utf8');
    const lines = validRecords.trimEnd().split('\n');
    await writeFile(journal, `${lines[0]}\n{"version":1,"operation":\n${lines[1]}\n`, 'utf8');
    const server = await start(port, root, makeLogger(records));
    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ ready: true, status: 'ready' });
    expect((await getValue(port, 'verified-prefix')).status).toBe(200);
    expect((await getValue(port, 'after-corruption')).status).toBe(404);
    expect((await readFile(journal, 'utf8')).trimEnd().split('\n')).toHaveLength(1);
    expect(records.some((record) => record.meta?.code === 'KB_STATE_BROKER_PERSISTENCE_CORRUPT')).toBe(true);
    expect(server).toBeDefined();
  });

  // case: S-280.9
  it('stops at the verified byte prefix before invalid UTF-8 and reports it through the daemon', async () => {
    const root = await makeRoot();
    const port = 9885;
    const records: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    await start(port, root);
    expect((await setValue(port, 'verified-prefix', 'kept', 60_000)).status).toBe(204);
    expect((await setValue(port, 'after-corruption', 'not recovered', 60_000)).status).toBe(204);
    await activeServers.pop()?.stop();

    const journal = path.join(root, 'state-broker', 'journal.jsonl');
    const original = await readFile(journal);
    const verifiedPrefixLength = original.indexOf(0x0a) + 1;
    const corrupted = Buffer.from(original);
    const corruptValueOffset = corrupted.indexOf(Buffer.from('not recovered'), verifiedPrefixLength);
    expect(corruptValueOffset).toBeGreaterThan(verifiedPrefixLength);
    corrupted[corruptValueOffset + 4] = 0xff;
    await writeFile(journal, corrupted);

    await start(port, root, makeLogger(records));
    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ ready: true, status: 'ready' });
    expect((await getValue(port, 'verified-prefix')).status).toBe(200);
    expect((await getValue(port, 'after-corruption')).status).toBe(404);
    expect(await readFile(journal)).toEqual(original.subarray(0, verifiedPrefixLength));
    expect(records.some((record) => record.meta?.code === 'KB_STATE_BROKER_PERSISTENCE_CORRUPT')).toBe(true);
  });

  // case: S-280.7
  it('keeps only the verified prefix before a partial crash tail and reports it through the daemon', async () => {
    const root = await makeRoot();
    const port = 9882;
    const records: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    await start(port, root);
    expect((await setValue(port, 'verified-prefix', 'kept', 60_000)).status).toBe(204);
    await activeServers.pop()?.stop();

    const journal = path.join(root, 'state-broker', 'journal.jsonl');
    const verified = await readFile(journal, 'utf8');
    const partialTail = '{"version":1,"operation":"set","key":"partial"';
    const trailingBytes = '\n{"version":1,"operation":"set","key":"trailing","value":"discard","expiresAt":9999999999999}\n';
    await writeFile(journal, `${verified}${partialTail}${trailingBytes}`, 'utf8');
    await start(port, root, makeLogger(records));

    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ ready: true, status: 'ready' });
    expect((await getValue(port, 'verified-prefix')).status).toBe(200);
    expect((await getValue(port, 'partial')).status).toBe(404);
    expect((await getValue(port, 'trailing')).status).toBe(404);
    expect(await readFile(journal, 'utf8')).toBe(verified);
    expect(records.some((record) => record.meta?.code === 'KB_STATE_BROKER_PERSISTENCE_CORRUPT')).toBe(true);
  });

  // case: S-280.6
  it('closes admission and drains before a second daemon acquires the journal lock', async () => {
    const root = await makeRoot();
    const firstPort = 9883;
    const secondPort = 9884;
    const first = await start(firstPort, root);
    try {
      expect((await setValue(firstPort, 'before-shutdown', 'durable', 60_000)).status).toBe(204);
      const stopping = first.stop();
      const lateMutation = setValue(firstPort, 'late', 'must-not-slip-past-lock-release', 60_000)
        .then((response) => response.status)
        .catch(() => null);
      const secondStarting = start(secondPort, root);
      await stopping;
      const lateStatus = await lateMutation;
      expect(lateStatus).not.toBe(204);
      await secondStarting;
      expect((await fetch(`http://127.0.0.1:${secondPort}/ready`)).status).toBe(200);
      expect((await getValue(secondPort, 'before-shutdown')).status).toBe(200);
      expect((await getValue(secondPort, 'late')).status).toBe(404);
    } finally {
      await Promise.all(activeServers.splice(0).map((server) => server.stop()));
    }
  });

  it('creates journal files only below the supplied platform data root', async () => {
    const root = await makeRoot();
    const port = 9881;
    await start(port, root);
    expect((await setValue(port, 'root-check', 'inside', 60_000)).status).toBe(204);
    const files = await readdir(root, { recursive: true });
    expect(files).toContain(path.join('state-broker', 'journal.jsonl'));
    expect(files.every((file) => !path.isAbsolute(file))).toBe(true);
  });
});
