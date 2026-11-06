import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppendOnlyJournalStateBroker } from '../backends/append-only-journal.js';

describe('StateBroker durability', () => {
  it('restores a resolved value after the broker is recreated', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kb-state-broker-roundtrip-'));
    try {
      const first = await AppendOnlyJournalStateBroker.open(root);
      await first.set('round-trip', { answer: 42 }, 60_000);
      await first.stop();

      const restarted = await AppendOnlyJournalStateBroker.open(root);
      await expect(restarted.get('round-trip')).resolves.toEqual({ answer: 42 });
      await restarted.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('replays absolute expiry using wall-clock time and keeps the current omitted-TTL default', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kb-state-broker-ttl-'));
    try {
      const first = await AppendOnlyJournalStateBroker.open(root);
      await first.set('unexpired', 'kept', 60_000);
      await first.set('expired', 'gone', 20);
      await first.set('default-ttl', 'default');
      await new Promise((resolve) => setTimeout(resolve, 35));
      await first.stop();

      const restarted = await AppendOnlyJournalStateBroker.open(root);
      await expect(restarted.get('unexpired')).resolves.toBe('kept');
      await expect(restarted.get('expired')).resolves.toBeNull();
      await expect(restarted.get('default-ttl')).resolves.toBe('default');
      await restarted.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps only the verified journal prefix before a malformed complete record', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kb-state-broker-corrupt-'));
    const journal = path.join(root, 'state-broker', 'journal.jsonl');
    try {
      const first = await AppendOnlyJournalStateBroker.open(root);
      await first.set('prefix', 'kept', 60_000);
      await first.set('later', 'not recovered', 60_000);
      await first.stop();

      const records = (await readFile(journal, 'utf8')).trimEnd().split('\n');
      await writeFile(journal, `${records[0]}\n{"version":1,"operation":\n${records[1]}\n`, 'utf8');
      const restarted = await AppendOnlyJournalStateBroker.open(root);
      expect(restarted.journalWasCorrupt).toBe(true);
      await expect(restarted.get('prefix')).resolves.toBe('kept');
      await expect(restarted.get('later')).resolves.toBeNull();
      expect((await readFile(journal, 'utf8')).trimEnd().split('\n')).toHaveLength(1);
      await restarted.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes its journal beneath the supplied platform data root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kb-state-broker-root-'));
    try {
      const broker = await AppendOnlyJournalStateBroker.open(root);
      await broker.set('root', 'inside', 60_000);
      await broker.stop();
      expect(await readdir(path.join(root, 'state-broker'))).toContain('journal.jsonl');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('syncs the journal directory before acknowledging its first append', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kb-state-broker-directory-sync-'));
    const probe = await open(root, 'r');
    const prototype = Object.getPrototypeOf(probe) as { sync: (...args: never[]) => Promise<void>; stat: () => Promise<{ isDirectory(): boolean }> };
    const originalSync = prototype.sync;
    let directorySyncs = 0;
    prototype.sync = async function (this: typeof probe, ...args: never[]) {
      if ((await this.stat()).isDirectory()) directorySyncs++;
      return originalSync.apply(this, args);
    };
    try {
      const broker = await AppendOnlyJournalStateBroker.open(root);
      directorySyncs = 0;
      await broker.set('first', 'durable', 60_000);
      expect(directorySyncs).toBeGreaterThan(0);
      await broker.stop();
    } finally {
      prototype.sync = originalSync;
      await probe.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('compacts mutation history to the current snapshot', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kb-state-broker-compaction-'));
    const journal = path.join(root, 'state-broker', 'journal.jsonl');
    try {
      const broker = await AppendOnlyJournalStateBroker.open(root);
      for (let value = 0; value < 1_000; value++) {
        await broker.set('current', value, 60_000);
      }
      await broker.stop();
      const records = (await readFile(journal, 'utf8')).trimEnd().split('\n');
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0]!).value).toBe(999);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes overlapping writers across processes through replay and compaction', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kb-state-broker-process-lock-'));
    const moduleUrl = new URL('../backends/append-only-journal.ts', import.meta.url).href;
    const vitestPath = createRequire(import.meta.url).resolve('vitest');
    const vitePath = createRequire(vitestPath).resolve('vite');
    const tsxLoader = createRequire(vitePath).resolve('tsx/esm');
    const childCode = `
      import { AppendOnlyJournalStateBroker } from ${JSON.stringify(moduleUrl)};
      if (process.env.JOURNAL_BARRIER === '1') {
        process.stdout.write('ready-to-open\\n');
        await new Promise((resolve) => process.stdin.once('data', resolve));
      }
      process.stdout.write('attempting-open\\n');
      const broker = await AppendOnlyJournalStateBroker.open(process.env.JOURNAL_ROOT);
      if (process.env.JOURNAL_ROLE === 'orphan') {
        process.stdout.write('locked-orphan\\n');
        await new Promise((resolve) => process.stdin.once('data', resolve));
      } else {
        const role = process.env.JOURNAL_ROLE;
        process.stdout.write('locked-' + role + '\\n');
        await broker.set('writer-' + role, 'acknowledged', 60000);
        if (role === 'first' || role === 'reclaimer-0') {
          for (let value = 0; value < 1000; value++) await broker.set('compact-me', value, 60000);
        }
      }
      await broker.stop();
      process.stdout.write('stopped\\n');
    `;
    const children: Array<{ child: ChildProcess; lines?: ReturnType<typeof createInterface> }> = [];
    const startChild = (role: string, barrier = false) => {
      const child = spawn(process.execPath, [
        '--import', tsxLoader, '--input-type=module', '-e', childCode,
      ], {
        env: { ...process.env, JOURNAL_ROOT: root, JOURNAL_ROLE: role, JOURNAL_BARRIER: barrier ? '1' : '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const tracked: { child: ChildProcess; lines?: ReturnType<typeof createInterface> } = { child };
      children.push(tracked);
      const stdout = child.stdout;
      const stdin = child.stdin;
      const stderr = child.stderr;
      if (!stdout || !stdin || !stderr) throw new Error('journal lock worker has no piped stdio');
      const lines = createInterface({ input: stdout });
      tracked.lines = lines;
      const seen = new Set<string>();
      const waiters = new Map<string, Array<{ resolve(): void; reject(error: Error): void }>>();
      const stderrChunks: Buffer[] = [];
      stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      lines.on('line', (value) => {
        seen.add(value);
        for (const waiter of waiters.get(value) ?? []) waiter.resolve();
        waiters.delete(value);
      });
      child.on('exit', (code, signal) => {
        if (code === 0) return;
        const failure = new Error(`journal worker exited (${code ?? signal}): ${Buffer.concat(stderrChunks).toString('utf8')}`);
        for (const waiting of waiters.values()) {
          for (const waiter of waiting) waiter.reject(failure);
        }
        waiters.clear();
      });
      const waitForLine = (line: string) => {
        if (seen.has(line)) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`timed out waiting for journal worker signal: ${line}`)), 10_000);
          const waiting = waiters.get(line) ?? [];
          waiting.push({
            resolve: () => { clearTimeout(timeout); resolve(); },
            reject: (error) => { clearTimeout(timeout); reject(error); },
          });
          waiters.set(line, waiting);
          child.once('error', (error) => { clearTimeout(timeout); reject(error); });
        });
      };
      return { child, stdin, lines, seen, waitForLine };
    };

    let second: ReturnType<typeof startChild> | undefined;
    try {
      const first = startChild('first');
      await first.waitForLine('locked-first');
      second = startChild('second');
      await second.waitForLine('attempting-open');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(second.seen.has('locked-second')).toBe(false);

      first.stdin.write('release\n');
      await first.waitForLine('stopped');
      await second.waitForLine('locked-second');
      await second.waitForLine('stopped');

      const restarted = await AppendOnlyJournalStateBroker.open(root);
      await expect(restarted.get('writer-first')).resolves.toBe('acknowledged');
      await expect(restarted.get('writer-second')).resolves.toBe('acknowledged');
      await expect(restarted.get('compact-me')).resolves.toBe(999);
      await restarted.stop();

      const orphan = startChild('orphan');
      await orphan.waitForLine('locked-orphan');
      orphan.child.kill('SIGKILL');
      await once(orphan.child, 'exit');
      const reclaimers = Array.from({ length: 16 }, (_, index) => startChild(`reclaimer-${index}`, true));
      await Promise.all(reclaimers.map((reclaimer) => reclaimer.waitForLine('ready-to-open')));
      for (const reclaimer of reclaimers) reclaimer.stdin.write('go\n');
      await Promise.all(reclaimers.map((reclaimer) => reclaimer.waitForLine('attempting-open')));
      await Promise.all(reclaimers.map((reclaimer) => reclaimer.waitForLine('stopped')));
      const afterReclaim = await AppendOnlyJournalStateBroker.open(root);
      await expect(afterReclaim.get('writer-reclaimer-0')).resolves.toBe('acknowledged');
      for (let index = 1; index < reclaimers.length; index++) {
        const role = `reclaimer-${index}`;
        await expect(afterReclaim.get(`writer-${role}`)).resolves.toBe('acknowledged');
      }
      await expect(afterReclaim.get('compact-me')).resolves.toBe(999);
      await afterReclaim.stop();
    } finally {
      const stopChild = async (child: ChildProcess | undefined) => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        await once(child, 'exit');
      };
      await Promise.all(children.map(({ child }) => stopChild(child)));
      for (const worker of children) worker.lines?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  // case: S-280.5
  it('preserves a live replacement lock while a stale reclaimer is reading the old lock inode', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kb-state-broker-reclaim-race-'));
    const liveRoot = path.join(root, 'live');
    const reclaimRoot = path.join(root, 'reclaim');
    const liveLockPath = path.join(liveRoot, 'state-broker', 'journal.jsonl.lock');
    const reclaimDirectory = path.join(reclaimRoot, 'state-broker');
    const lockPath = path.join(reclaimDirectory, 'journal.jsonl.lock');
    const reclaimPath = `${lockPath}.reclaim`;
    const rereadFifoPath = path.join(reclaimDirectory, 'journal.jsonl.lock.reread');
    const moduleUrl = new URL('../backends/append-only-journal.ts', import.meta.url).href;
    const vitestPath = createRequire(import.meta.url).resolve('vitest');
    const vitePath = createRequire(vitestPath).resolve('vite');
    const tsxLoader = createRequire(vitePath).resolve('tsx/esm');
    const childCode = `
      import { AppendOnlyJournalStateBroker } from ${JSON.stringify(moduleUrl)};
      process.stdout.write('attempting-open\\n');
      const broker = await AppendOnlyJournalStateBroker.open(process.env.JOURNAL_ROOT);
      process.stdout.write('locked\\n');
      if (process.env.JOURNAL_HOLD === '1') await new Promise((resolve) => process.stdin.once('data', resolve));
      await broker.stop();
      process.stdout.write('stopped\\n');
    `;
    const startChild = (dataRoot: string, hold: boolean) => {
      const child = spawn(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', childCode], {
        env: { ...process.env, JOURNAL_ROOT: dataRoot, JOURNAL_HOLD: hold ? '1' : '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout = child.stdout;
      const stdin = child.stdin;
      const stderr = child.stderr;
      if (!stdout || !stdin || !stderr) throw new Error('journal lock worker has no piped stdio');
      const lines = createInterface({ input: stdout });
      const seen = new Set<string>();
      const waiters = new Map<string, Array<{ resolve(): void; reject(error: Error): void }>>();
      const stderrChunks: Buffer[] = [];
      stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      lines.on('line', (value) => {
        seen.add(value);
        for (const waiter of waiters.get(value) ?? []) waiter.resolve();
        waiters.delete(value);
      });
      child.on('exit', (code, signal) => {
        if (code === 0) return;
        const failure = new Error(`journal worker exited (${code ?? signal}): ${Buffer.concat(stderrChunks).toString('utf8')}`);
        for (const waiting of waiters.values()) for (const waiter of waiting) waiter.reject(failure);
        waiters.clear();
      });
      const waitForLine = (line: string) => {
        if (seen.has(line)) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`timed out waiting for journal worker signal: ${line}`)), 10_000);
          const waiting = waiters.get(line) ?? [];
          waiting.push({
            resolve: () => { clearTimeout(timeout); resolve(); },
            reject: (error) => { clearTimeout(timeout); reject(error); },
          });
          waiters.set(line, waiting);
          child.once('error', (error) => { clearTimeout(timeout); reject(error); });
        });
      };
      return { child, stdin, lines, waitForLine };
    };

    const live = startChild(liveRoot, true);
    let reclaimer: ReturnType<typeof startChild> | undefined;
    let fifoWriter: Awaited<ReturnType<typeof open>> | undefined;
    let liveReleased = false;
    try {
      await live.waitForLine('locked');
      const liveRecord = JSON.parse(await readFile(liveLockPath, 'utf8')) as { pid: number; token: string };
      await mkdir(reclaimDirectory, { recursive: true });
      execFileSync('mkfifo', [lockPath]);

      reclaimer = startChild(reclaimRoot, false);
      await reclaimer.waitForLine('attempting-open');
      fifoWriter = await open(lockPath, 'w');
      const staleProcess = spawn(process.execPath, ['-e', 'process.exit(0)']);
      const stalePid = staleProcess.pid;
      if (!stalePid) throw new Error('could not start stale lock owner process');
      await once(staleProcess, 'exit');
      await fifoWriter.writeFile(JSON.stringify({ pid: stalePid, token: 'stale-owner' }), 'utf8');
      await rename(lockPath, rereadFifoPath);
      execFileSync('mkfifo', [lockPath]);
      await fifoWriter.close();
      fifoWriter = undefined;

      const gateDeadline = Date.now() + 10_000;
      while (Date.now() < gateDeadline) {
        try {
          await stat(reclaimPath);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (Date.now() >= gateDeadline) throw new Error('timed out waiting for the reread rendezvous');

      fifoWriter = await open(lockPath, 'w');
      await fifoWriter.writeFile(JSON.stringify(liveRecord), 'utf8');
      await fifoWriter.close();
      fifoWriter = undefined;
      await rename(liveLockPath, lockPath);

      const reclaimDeadline = Date.now() + 10_000;
      while (Date.now() < reclaimDeadline) {
        try {
          await stat(reclaimPath);
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          break;
        }
      }
      expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(liveRecord);
      live.stdin.write('release\n');
      liveReleased = true;
      await live.waitForLine('stopped');
    } finally {
      await fifoWriter?.close();
      if (!liveReleased) live.stdin.write('release\n');
      const stopChild = async (child: ChildProcess | undefined) => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        await once(child, 'exit');
      };
      await Promise.all([stopChild(live.child), stopChild(reclaimer?.child)]);
      live.lines.close();
      reclaimer?.lines.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
