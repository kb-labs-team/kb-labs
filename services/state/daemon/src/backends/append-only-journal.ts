import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { InMemoryStateBroker } from '@kb-labs/core-state-broker';

type JournalRecord =
  | { version: 1; operation: 'set'; key: string; value: unknown; expiresAt: number }
  | { version: 1; operation: 'delete'; key: string }
  | { version: 1; operation: 'clear'; pattern?: string };

const DEFAULT_TTL_MS = 300_000;
const COMPACT_AFTER_RECORDS = 1_000;

/** StateBroker backend that syncs every resolved mutation to a local journal. */
export class AppendOnlyJournalStateBroker extends InMemoryStateBroker {
  private readonly journalPath: string;
  private readonly lockPath: string;
  private readonly ownerToken: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private journalRecords = 0;
  private corrupted = false;
  private lockOwned = false;

  private constructor(dataRoot: string, cleanupIntervalMs: number) {
    super(cleanupIntervalMs);
    this.journalPath = path.join(dataRoot, 'state-broker', 'journal.jsonl');
    this.lockPath = `${this.journalPath}.lock`;
    this.ownerToken = randomUUID();
  }

  static async open(dataRoot: string, cleanupIntervalMs = 30_000): Promise<AppendOnlyJournalStateBroker> {
    const broker = new AppendOnlyJournalStateBroker(dataRoot, cleanupIntervalMs);
    try {
      const stateDirectory = path.dirname(broker.journalPath);
      await mkdir(stateDirectory, { recursive: true });
      await syncDirectoryChain(stateDirectory);
      await broker.acquireWriterLock();
      await broker.replay();
    } catch (error) {
      await broker.stop();
      throw error;
    }
    return broker;
  }

  get journalWasCorrupt(): boolean {
    return this.corrupted;
  }

  override async set<T>(key: string, value: T, ttl = DEFAULT_TTL_MS): Promise<void> {
    const expiresAt = Date.now() + ttl;
    const record: JournalRecord = { version: 1, operation: 'set', key, value, expiresAt };
    await this.enqueue(async () => {
      await this.append(record);
      await super.set(key, value, Math.max(0, expiresAt - Date.now()));
      await this.compactIfNeeded();
    });
  }

  override async delete(key: string): Promise<void> {
    await this.enqueue(async () => {
      await this.append({ version: 1, operation: 'delete', key });
      await super.delete(key);
      await this.compactIfNeeded();
    });
  }

  override async clear(pattern?: string): Promise<void> {
    await this.enqueue(async () => {
      await this.append(pattern === undefined
        ? { version: 1, operation: 'clear' }
        : { version: 1, operation: 'clear', pattern });
      await super.clear(pattern);
      await this.compactIfNeeded();
    });
  }

  override async setIfNotExists<T>(key: string, value: T, ttl = DEFAULT_TTL_MS): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.hasLiveEntry(key)) return false;
      const expiresAt = Date.now() + ttl;
      await this.append({ version: 1, operation: 'set', key, value, expiresAt });
      await super.set(key, value, Math.max(0, expiresAt - Date.now()));
      await this.compactIfNeeded();
      return true;
    });
  }

  override async stop(): Promise<void> {
    try {
      await this.writeQueue;
    } finally {
      try {
        await super.stop();
      } finally {
        await this.releaseWriterLock();
      }
    }
  }

  private async acquireWriterLock(): Promise<void> {
    const owner = JSON.stringify({ pid: process.pid, token: this.ownerToken });
    const ownerPath = `${this.lockPath}.${process.pid}.${this.ownerToken}.owner`;
    const ownerHandle = await open(ownerPath, 'wx', 0o600);
    try {
      await ownerHandle.writeFile(owner, 'utf8');
      await ownerHandle.sync();
    } finally {
      await ownerHandle.close();
    }
    try {
      for (;;) {
        try {
          await link(ownerPath, this.lockPath);
          this.lockOwned = true;
          return;
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
        }

        const existing = await this.readWriterLock();
        if (existing === null) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        if (existing.pid === process.pid) {
          throw new Error(`StateBroker journal already has a writer in process ${process.pid}.`);
        }
        if (!isProcessAlive(existing.pid)) {
          await this.reclaimStaleWriterLock(existing);
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      await rm(ownerPath, { force: true });
    }
  }

  private async reclaimStaleWriterLock(observed: { pid: number; token: string }): Promise<void> {
    const reclaimPath = `${this.lockPath}.reclaim`;
    for (;;) {
      try {
        await mkdir(reclaimPath);
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    try {
      const current = await this.readWriterLock();
      if (current?.pid === observed.pid && current.token === observed.token && !isProcessAlive(current.pid)) {
        await rm(this.lockPath, { force: true });
      }
    } finally {
      await rmdir(reclaimPath);
    }
  }

  private async readWriterLock(): Promise<{ pid: number; token: string } | null> {
    let content: string;
    try {
      content = await readFile(this.lockPath, 'utf8');
    } catch (error) {
      if (isMissingPath(error)) return null;
      throw error;
    }
    const value: unknown = JSON.parse(content);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`StateBroker journal writer lock at ${this.lockPath} is malformed.`);
    }
    const record = value as Record<string, unknown>;
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 || typeof record.token !== 'string') {
      throw new Error(`StateBroker journal writer lock at ${this.lockPath} is malformed.`);
    }
    return { pid: record.pid as number, token: record.token };
  }

  private async releaseWriterLock(): Promise<void> {
    if (!this.lockOwned) return;
    const existing = await this.readWriterLock();
    if (existing?.pid === process.pid && existing.token === this.ownerToken) {
      await rm(this.lockPath, { force: true });
    }
    this.lockOwned = false;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.then(() => undefined);
    return result;
  }

  private async append(record: JournalRecord): Promise<void> {
    let created = false;
    let handle;
    try {
      handle = await open(this.journalPath, 'wx');
      created = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      handle = await open(this.journalPath, 'a');
    }
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (created) await syncDirectoryChain(path.dirname(this.journalPath));
    this.journalRecords++;
  }

  private async replay(): Promise<void> {
    let contents: Buffer;
    try {
      contents = await readFile(this.journalPath);
    } catch (error) {
      if (isMissingPath(error)) return;
      throw error;
    }

    let verifiedBytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let lineStart = 0;
    while (lineStart < contents.length) {
      const lineEnd = contents.indexOf(0x0a, lineStart);
      const completeLine = lineEnd !== -1;
      let record: JournalRecord;
      try {
        if (!completeLine) throw new Error('incomplete final record');
        const line = decoder.decode(contents.subarray(lineStart, lineEnd));
        const parsed: unknown = JSON.parse(line);
        if (!isJournalRecord(parsed)) throw new Error('record does not match journal format');
        record = parsed;
      } catch {
        this.corrupted = true;
        break;
      }
      await this.apply(record);
      verifiedBytes = lineEnd + 1;
      this.journalRecords++;
      lineStart = lineEnd + 1;
    }

    if (this.corrupted) {
      const handle = await open(this.journalPath, 'r+');
      try {
        await handle.truncate(verifiedBytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }

  private async apply(record: JournalRecord): Promise<void> {
    switch (record.operation) {
      case 'set': {
        const ttl = record.expiresAt - Date.now();
        if (ttl > 0) await super.set(record.key, record.value, ttl);
        return;
      }
      case 'delete':
        await super.delete(record.key);
        return;
      case 'clear':
        await super.clear(record.pattern);
        return;
    }
  }

  private async compactIfNeeded(): Promise<void> {
    if (this.journalRecords < COMPACT_AFTER_RECORDS) return;
    const entries = this.snapshotEntries();
    const temporaryPath = `${this.journalPath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporaryPath, 'w');
    try {
      for (const entry of entries) {
        const record: JournalRecord = {
          version: 1,
          operation: 'set',
          key: entry.key,
          value: entry.value,
          expiresAt: entry.expiresAt,
        };
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.journalPath);
    const directory = await open(path.dirname(this.journalPath), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    this.journalRecords = entries.length;
  }
}

function isJournalRecord(value: unknown): value is JournalRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.operation !== 'string') return false;
  if (record.operation === 'set') {
    return typeof record.key === 'string' && typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) && 'value' in record;
  }
  if (record.operation === 'delete') return typeof record.key === 'string';
  if (record.operation === 'clear') return record.pattern === undefined || typeof record.pattern === 'string';
  return false;
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return true;
    throw error;
  }
}

async function syncDirectoryChain(directory: string): Promise<void> {
  let current = path.resolve(directory);
  for (;;) {
    const handle = await open(current, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
