/**
 * @module @kb-labs/core-registry/snapshot/snapshot-manager
 * Manages snapshot persistence (disk + platform.cache).
 *
 * Adapted from @kb-labs/cli-api/modules/snapshot. Direct Redis references
 * replaced with platform ICache abstraction.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolveRuntimeStatePath } from '@kb-labs/core-project-registry';
import { getDiscoveryInputPaths } from '@kb-labs/core-discovery';
import { promises as fsPromises } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import type { ICache } from '@kb-labs/core-platform/adapters';
import type { RegistrySnapshot, RegistrySnapshotManifestEntry, SnapshotWithoutIntegrity } from '@kb-labs/plugin-contracts';
import { cloneValue, computeSnapshotChecksum, safeParseInt, SNAPSHOT_CHECKSUM_ALGORITHM } from './snapshot-utils.js';

/** Runtime state (ADR-0044): lives under `<KB_HOME>/state/<projectId>/cache/`, not in the repository. */
const SNAPSHOT_DIR = ['cache'] as const;
const SNAPSHOT_FILE = 'registry.json';
const SNAPSHOT_BACKUP = 'registry.prev.json';
const DEFAULT_TTL_MS = 60_000;

export interface SnapshotManagerOptions {
  root: string;
  discoveryRoots?: readonly string[];
  ttlMs?: number;
  platformVersion: string;
  cache?: ICache;
  cacheSnapshotKey?: string;
  persistSnapshot?: boolean;
  /** Machine-level root for runtime state. Defaults to `$KB_HOME` or `~/.kb`. */
  kbHome?: string;
}

export class SnapshotManager {
  private readonly snapshotDir: string;
  private readonly snapshotPath: string;
  private readonly backupPath: string;
  private readonly ttlMs: number;
  private readonly platformVersion: string;
  private readonly cache?: ICache;
  private readonly cacheKey?: string;
  private readonly persistSnapshot: boolean;
  private readonly root: string;
  private readonly discoveryRoots: readonly string[];
  private lastChecksum: string | null = null;
  private persistLock: Promise<void> = Promise.resolve();

  constructor(opts: SnapshotManagerOptions) {
    this.root = resolve(opts.root);
    this.discoveryRoots = [...new Set((opts.discoveryRoots ?? [this.root]).map(root => resolve(root)))];
    const stateOptions = { root: opts.kbHome };
    this.snapshotPath = resolveRuntimeStatePath(this.root, [...SNAPSHOT_DIR, SNAPSHOT_FILE], stateOptions);
    this.backupPath = resolveRuntimeStatePath(this.root, [...SNAPSHOT_DIR, SNAPSHOT_BACKUP], stateOptions);
    this.snapshotDir = dirname(this.snapshotPath);
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.platformVersion = opts.platformVersion;
    this.cache = opts.cache;
    this.cacheKey = opts.cacheSnapshotKey;
    this.persistSnapshot = opts.persistSnapshot ?? true;
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
    const primary = this.readDisk(this.snapshotPath);
    if (primary && !primary.corrupted) {
      this.lastChecksum = primary.checksum ?? null;
      return this.markStaleness(primary);
    }

    // Disk backup
    const backup = this.readDisk(this.backupPath);
    if (backup && !backup.corrupted) {
      this.lastChecksum = backup.checksum ?? null;
      return this.markStaleness(backup);
    }

    return null;
  }

  /** Persist snapshot to disk + platform cache. Serialized to prevent races. */
  async persist(snapshot: RegistrySnapshot): Promise<void> {
    if (!this.persistSnapshot) return;
    // Serialize concurrent persist() calls
    this.persistLock = this.persistLock.then(() => this.doPersist(snapshot));
    return this.persistLock;
  }

  private async doPersist(snapshot: RegistrySnapshot): Promise<void> {
    const finalized = this.ensureIntegrity({
      ...snapshot,
      inputFingerprint: this.computeInputFingerprint(snapshot.manifests),
    });

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
      inputFingerprint: this.computeInputFingerprint([]),
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
    const inputsChanged = snapshot.inputFingerprint !== this.computeInputFingerprint(snapshot.manifests);
    const stale = expired || inputsChanged;
    if (snapshot.stale === stale) {return snapshot;}
    return { ...snapshot, stale, partial: snapshot.partial || stale };
  }

  /** Hash every root input used by core-discovery and each loaded manifest artifact. */
  computeInputFingerprint(manifests: readonly RegistrySnapshotManifestEntry[]): string {
    const paths = new Set(getDiscoveryInputPaths(this.discoveryRoots));
    for (const entry of manifests) {
      const manifestPath = this.resolveManifestFile(entry.pluginRoot);
      if (manifestPath) paths.add(manifestPath);
    }

    const hash = createHash('sha256');
    for (const inputPath of [...paths].sort()) {
      hash.update(inputPath).update('\0');
      try {
        hash.update(readFileSync(inputPath));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          hash.update('<missing>');
        } else {
          throw error;
        }
      }
      hash.update('\0');
    }
    return hash.digest('hex');
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
          packageName: e.packageName,
          scope: e.scope,
          origin: e.origin,
          manifestPath: e.manifestPath,
          manifestKind: e.manifestKind,
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
      inputFingerprint: typeof raw.inputFingerprint === 'string' ? raw.inputFingerprint : '',
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
