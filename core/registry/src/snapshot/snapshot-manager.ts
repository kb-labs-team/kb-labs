/**
 * @module @kb-labs/core-registry/snapshot/snapshot-manager
 * Manages snapshot persistence (disk + platform.cache).
 *
 * Adapted from @kb-labs/cli-api/modules/snapshot. Direct Redis references
 * replaced with platform ICache abstraction.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolveRuntimeStatePath } from '@kb-labs/core-project-registry';
import { promises as fsPromises } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ICache } from '@kb-labs/core-platform/adapters';
import type { RegistrySnapshot, RegistrySnapshotManifestEntry, SnapshotWithoutIntegrity } from '../types.js';
import { cloneValue, computeSnapshotChecksum, safeParseInt, SNAPSHOT_CHECKSUM_ALGORITHM } from './snapshot-utils.js';

/** Runtime state (ADR-0044): lives under `<KB_HOME>/state/<projectId>/cache/`, not in the repository. */
const SNAPSHOT_DIR = ['cache'] as const;
const SNAPSHOT_FILE = 'registry.json';
const SNAPSHOT_BACKUP = 'registry.prev.json';
const DEFAULT_TTL_MS = 60_000;
const MARKETPLACE_LOCK_PATH = ['.kb', 'marketplace.lock'] as const;

export interface SnapshotManagerOptions {
  root: string;
  ttlMs?: number;
  platformVersion: string;
  cache?: ICache;
  cacheSnapshotKey?: string;
  /** Machine-level root for runtime state. Defaults to `$KB_HOME` or `~/.kb`. */
  kbHome?: string;
}

export class SnapshotManager {
  private readonly snapshotDir: string;
  private readonly snapshotPath: string;
  private readonly backupPath: string;
  /** Pre-migration in-repo locations, read-only fallback for one release. */
  private readonly legacySnapshotPath: string;
  private readonly legacyBackupPath: string;
  private readonly ttlMs: number;
  private readonly platformVersion: string;
  private readonly cache?: ICache;
  private readonly cacheKey?: string;
  private readonly root: string;
  private lastChecksum: string | null = null;
  private persistLock: Promise<void> = Promise.resolve();

  constructor(opts: SnapshotManagerOptions) {
    this.root = resolve(opts.root);
    const stateOptions = { root: opts.kbHome };
    const snapshot = resolveRuntimeStatePath(this.root, [...SNAPSHOT_DIR, SNAPSHOT_FILE], stateOptions);
    const backup = resolveRuntimeStatePath(this.root, [...SNAPSHOT_DIR, SNAPSHOT_BACKUP], stateOptions);
    this.snapshotDir = dirname(snapshot.path);
    this.snapshotPath = snapshot.path;
    this.backupPath = backup.path;
    this.legacySnapshotPath = snapshot.legacyPath;
    this.legacyBackupPath = backup.legacyPath;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.platformVersion = opts.platformVersion;
    this.cache = opts.cache;
    this.cacheKey = opts.cacheSnapshotKey;
  }

  /** Load snapshot: memory cache → disk primary → disk backup → null. */
  async load(): Promise<RegistrySnapshot | null> {
    // Try platform cache first
    if (this.cache && this.cacheKey) {
      try {
        const raw = await this.cache.get<string>(this.cacheKey);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<RegistrySnapshot>;
          const normalized = this.normalize(parsed);
          if (!normalized.corrupted) {
            return this.markStaleness(normalized);
          }
        }
      } catch { /* cache miss — fall through */ }
    }

    // Disk primary
    const primary = this.readDisk(this.snapshotPath) ?? this.readDisk(this.legacySnapshotPath);
    if (primary && !primary.corrupted) {
      this.lastChecksum = primary.checksum ?? null;
      return this.markStaleness(primary);
    }

    // Disk backup
    const backup = this.readDisk(this.backupPath) ?? this.readDisk(this.legacyBackupPath);
    if (backup && !backup.corrupted) {
      this.lastChecksum = backup.checksum ?? null;
      return this.markStaleness(backup);
    }

    return null;
  }

  /** Persist snapshot to disk + platform cache. Serialized to prevent races. */
  async persist(snapshot: RegistrySnapshot): Promise<void> {
    // Serialize concurrent persist() calls
    this.persistLock = this.persistLock.then(() => this.doPersist(snapshot));
    return this.persistLock;
  }

  private async doPersist(snapshot: RegistrySnapshot): Promise<void> {
    const finalized = this.ensureIntegrity(snapshot);

    // Atomic write to disk (tmp → rename)
    try {
      await fsPromises.mkdir(this.snapshotDir, { recursive: true });
      if (existsSync(this.snapshotPath)) {
        try {
          await fsPromises.copyFile(this.snapshotPath, this.backupPath);
        } catch { /* best-effort backup */ }
      }
      const tmpPath = join(this.snapshotDir, `registry.tmp.${randomUUID()}.json`);
      await fsPromises.writeFile(tmpPath, JSON.stringify(finalized, null, 2), 'utf8');
      await fsPromises.rename(tmpPath, this.snapshotPath);
      this.lastChecksum = finalized.checksum ?? null;
    } catch { /* disk failure is non-fatal */ }

    // Write to platform cache
    if (this.cache && this.cacheKey) {
      try {
        await this.cache.set(this.cacheKey, JSON.stringify(finalized), this.ttlMs);
      } catch { /* cache write failure is non-fatal */ }
    }
  }

  createEmpty(): RegistrySnapshot {
    const generatedAt = new Date().toISOString();
    const base: SnapshotWithoutIntegrity = {
      schema: 'kb.registry/1',
      rev: 0,
      version: '0',
      generatedAt,
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
      ttlMs: this.ttlMs,
      partial: true,
      stale: false,
      source: { platformVersion: this.platformVersion, cwd: this.root },
      plugins: [],
      manifests: [],
      ts: Date.parse(generatedAt),
    };
    return this.ensureIntegrity(base as RegistrySnapshot);
  }

  getRoot(): string { return this.root; }
  getTtlMs(): number { return this.ttlMs; }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private readDisk(path: string): RegistrySnapshot | null {
    if (!existsSync(path)) {return null;}
    try {
      const raw = readFileSync(path, 'utf8');
      return this.normalize(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private markStaleness(snapshot: RegistrySnapshot): RegistrySnapshot {
    const expired = snapshot.expiresAt ? Date.now() > Date.parse(snapshot.expiresAt) : false;
    const lockChanged = this.isLockNewerThanSnapshot(snapshot);
    const manifestChanged = this.isAnyManifestNewerThanSnapshot(snapshot);
    const stale = expired || lockChanged || manifestChanged;
    if (snapshot.stale === stale) {return snapshot;}
    return { ...snapshot, stale, partial: snapshot.partial || stale };
  }

  private isLockNewerThanSnapshot(snapshot: RegistrySnapshot): boolean {
    try {
      const lockPath = join(this.root, ...MARKETPLACE_LOCK_PATH);
      const lockMtime = statSync(lockPath).mtimeMs;
      const snapshotTs = snapshot.ts ?? Date.parse(snapshot.generatedAt);
      return lockMtime > snapshotTs;
    } catch {
      return false;
    }
  }

  /**
   * Detect a rebuilt plugin whose manifest artifact changed on disk after the
   * snapshot was written. Installing/removing a plugin bumps marketplace.lock
   * (covered by isLockNewerThanSnapshot), but rebuilding an *already-installed*
   * plugin (e.g. fixing handler paths in its manifest and re-running the build)
   * leaves the lock untouched — so without this check a stale registry.json
   * keeps serving the old handler paths until it is manually deleted (#23).
   */
  private isAnyManifestNewerThanSnapshot(snapshot: RegistrySnapshot): boolean {
    const snapshotTs = snapshot.ts ?? Date.parse(snapshot.generatedAt);
    if (!Number.isFinite(snapshotTs)) {return false;}

    for (const entry of snapshot.manifests) {
      const manifestFile = this.resolveManifestFile(entry.pluginRoot);
      if (!manifestFile) {continue;}
      try {
        if (statSync(manifestFile).mtimeMs > snapshotTs) {return true;}
      } catch { /* manifest file removed — let discovery re-resolve it */ }
    }
    return false;
  }

  /**
   * Resolve the on-disk manifest artifact for a plugin root, mirroring the
   * precedence used by core-discovery's loadManifest:
   *   1. package.json `kbLabs.manifest` / `kb.manifest` pointer
   *   2. kb.plugin.json
   *   3. dist/index.js
   * Returns null when none can be located.
   */
  private resolveManifestFile(pluginRoot: string): string | null {
    if (!pluginRoot) {return null;}

    try {
      const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')) as {
        kbLabs?: { manifest?: unknown };
        kb?: { manifest?: unknown };
      };
      const pointer = pkg.kbLabs?.manifest ?? pkg.kb?.manifest;
      if (typeof pointer === 'string' && pointer.length > 0) {
        return resolve(pluginRoot, pointer);
      }
    } catch { /* no/invalid package.json — fall through */ }

    const kbPluginJson = join(pluginRoot, 'kb.plugin.json');
    if (existsSync(kbPluginJson)) {return kbPluginJson;}

    const distIndex = join(pluginRoot, 'dist', 'index.js');
    if (existsSync(distIndex)) {return distIndex;}

    return null;
  }

  private normalize(raw: Partial<RegistrySnapshot>): RegistrySnapshot {
    const schemaValid = raw.schema === 'kb.registry/1';
    const generatedAt = typeof raw.generatedAt === 'string' ? raw.generatedAt : new Date().toISOString();
    const ttlMs = typeof raw.ttlMs === 'number' && Number.isFinite(raw.ttlMs)
      ? Math.max(1_000, Math.floor(raw.ttlMs))
      : this.ttlMs;
    const expiresAt = typeof raw.expiresAt === 'string'
      ? raw.expiresAt
      : new Date(Date.parse(generatedAt) + ttlMs).toISOString();
    const rev = typeof raw.rev === 'number' && Number.isFinite(raw.rev) ? raw.rev : safeParseInt(raw.version);
    const version = typeof raw.version === 'string' && raw.version.trim().length > 0 ? raw.version : String(rev);
    const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : Date.parse(generatedAt);

    const manifests: RegistrySnapshotManifestEntry[] = Array.isArray(raw.manifests)
      ? raw.manifests.map(e => ({
          pluginId: e.pluginId,
          manifest: cloneValue(e.manifest),
          pluginRoot: e.pluginRoot,
          source: { ...e.source },
        }))
      : [];

    const base: SnapshotWithoutIntegrity = {
      schema: 'kb.registry/1',
      rev,
      version,
      generatedAt,
      expiresAt,
      ttlMs,
      partial: raw.partial ?? true,
      stale: raw.stale ?? (expiresAt ? Date.now() > Date.parse(expiresAt) : false),
      source: raw.source ?? { platformVersion: this.platformVersion, cwd: this.root },
      corrupted: !schemaValid || raw.corrupted === true,
      plugins: Array.isArray(raw.plugins) ? raw.plugins : [],
      manifests,
      ts,
    };

    return this.ensureIntegrity(base as RegistrySnapshot);
  }

  private ensureIntegrity(snapshot: RegistrySnapshot): RegistrySnapshot {
    const { checksum, checksumAlgorithm, previousChecksum: _previousChecksum, corrupted, ...rest } = snapshot;
    const computed = computeSnapshotChecksum(rest as SnapshotWithoutIntegrity);
    const matches = typeof checksum === 'string' && checksum.length > 0
      && (checksumAlgorithm ?? SNAPSHOT_CHECKSUM_ALGORITHM) === SNAPSHOT_CHECKSUM_ALGORITHM
      && checksum === computed;

    return {
      ...rest,
      corrupted: Boolean(corrupted) || (checksum !== undefined && !matches),
      checksum: computed,
      checksumAlgorithm: SNAPSHOT_CHECKSUM_ALGORITHM,
      previousChecksum: this.lastChecksum,
    } as RegistrySnapshot;
  }
}
