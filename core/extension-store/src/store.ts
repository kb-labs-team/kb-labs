/**
 * @module @kb-labs/core-extension-store/store
 * The shared per-machine store of installed plugin/adapter versions
 * (ADR-0048 D2). One directory per exact version, never modified after
 * publish; two projects pinning one version share it, different versions
 * coexist side by side.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock, type FileLockOptions } from '@kb-labs/core-project-registry';
import { STORE_ENTRY_SCHEMA, type StoreEntry, type InstallPackageRequest, type PackageInstaller, type ResolvedStoreEntry, type StoreEntryRef } from './types.js';
import { readStoreEntry, serializeStoreEntry } from './entry.js';
import { readStaticManifest } from './manifest.js';
import { PnpmInstaller } from './pnpm-installer.js';
import { IntegrityMismatchError } from './errors.js';
import {
  entryPackagePath,
  resolveEntryDir,
  resolveStoreRoot,
  storeCasDir,
  storeEntriesDir,
  storeLockPath,
  storeTmpDir,
  type StoreRootOptions,
} from './store-paths.js';

/** How often the `.used` mtime marker is refreshed on a hit — at most once a day (ADR-0048 D2). */
const USED_MARKER_REFRESH_MS = 24 * 60 * 60 * 1000;

export interface ExtensionStoreOptions extends StoreRootOptions {
  /** Installed platform root whose cached package artifacts may back local file dependencies. */
  platformRoot?: string;
  /** Package installer. Defaults to a real `pnpm install`. Tests may substitute a fake. */
  installer?: PackageInstaller;
  now?: () => Date;
  lock?: FileLockOptions;
}

export interface IExtensionStore {
  readonly root: string;
  readonly casDir: string;
  readonly entriesDir: string;

  /**
   * Read-only lookup: returns the entry if it is already in the store, never
   * installs. Verifies integrity against `expectedIntegrity` when given (a
   * project's pin) and throws `IntegrityMismatchError` on mismatch.
   */
  lookup(ref: StoreEntryRef & { expectedIntegrity?: string }): Promise<ResolvedStoreEntry | undefined>;

  /**
   * Version resolution (ADR-0048 D4 step 3-4): returns the on-disk path for
   * `name`@`version`, installing it into the store first if it is not already
   * present. Concurrent callers racing for the same version install it once.
   */
  resolve(request: InstallPackageRequest): Promise<ResolvedStoreEntry>;

  /** Every published entry (`entry.json` present) — the read side a future `kb plugin gc` mark phase needs. */
  listEntries(): Promise<StoreEntry[]>;
}

export function createExtensionStore(options: ExtensionStoreOptions = {}): IExtensionStore {
  const root = resolveStoreRoot(options);
  const entriesDir = storeEntriesDir(root);
  const casDir = storeCasDir(root);
  const tmpDir = storeTmpDir(root);
  const lockPath = storeLockPath(root);
  const installer = options.installer ?? new PnpmInstaller();
  const now = options.now ?? (() => new Date());

  const entryJsonPath = (name: string, version: string): { entryDir: string; entryJsonPath: string } => {
    const entryDir = resolveEntryDir(root, name, version);
    return { entryDir, entryJsonPath: join(entryDir, 'entry.json') };
  };

  const toResolved = (entry: StoreEntry, entryDir: string): ResolvedStoreEntry => ({
    entry,
    entryDir,
    packageRoot: entryPackagePath(entryDir, entry.name),
  });

  const verifyIntegrity = (name: string, entry: StoreEntry, expectedIntegrity: string | undefined): void => {
    if (expectedIntegrity && entry.integrity !== expectedIntegrity) {
      throw new IntegrityMismatchError({ plugin: name, expected: expectedIntegrity, actual: entry.integrity });
    }
  };

  /** Touches `<entryDir>/.used`, but at most once a day, so a light load path never becomes a write storm. */
  const touchUsed = async (entryDir: string): Promise<void> => {
    const markerPath = join(entryDir, '.used');
    try {
      const stat = await fs.stat(markerPath);
      if (now().getTime() - stat.mtimeMs < USED_MARKER_REFRESH_MS) {return;}
    } catch {
      // No marker yet — fall through and create one.
    }
    await fs.writeFile(markerPath, '').catch(() => undefined); // best-effort: never fails a resolution
  };

  const lookup: IExtensionStore['lookup'] = async ({ name, version, expectedIntegrity }) => {
    const { entryDir, entryJsonPath: file } = entryJsonPath(name, version);
    const entry = await readStoreEntry(file);
    if (!entry) {return undefined;}
    verifyIntegrity(name, entry, expectedIntegrity);
    await touchUsed(entryDir);
    return toResolved(entry, entryDir);
  };

  const install = async (request: InstallPackageRequest): Promise<ResolvedStoreEntry> => {
    const { name, version, kind, spec, expectedIntegrity } = request;
    const staging = join(tmpDir, randomUUID());
    try {
      const result = await installer.install({
        name,
        version,
        spec,
        expectedIntegrity,
        projectDir: staging,
        casDir,
        ...(options.platformRoot ? { platformRoot: options.platformRoot } : {}),
      });
      if (expectedIntegrity && result.integrity !== expectedIntegrity) {
        throw new IntegrityMismatchError({ plugin: name, expected: expectedIntegrity, actual: result.integrity });
      }
      const manifest = await readStaticManifest(result.packageRoot);
      const entry: StoreEntry = {
        schema: STORE_ENTRY_SCHEMA,
        name,
        version,
        kind,
        integrity: result.integrity,
        manifest,
        installedAt: now().toISOString(),
      };
      // entry.json is written last inside the staging dir: its presence marks
      // the entry complete (ADR-0048 D2). The whole directory is then published
      // by a single atomic rename.
      await fs.writeFile(join(staging, 'entry.json'), serializeStoreEntry(entry), 'utf-8');

      const { entryDir } = entryJsonPath(name, version);
      await fs.mkdir(entriesDir, { recursive: true });
      await fs.rename(staging, entryDir);
      await touchUsed(entryDir);
      return toResolved(entry, entryDir);
    } catch (err) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  };

  const resolve: IExtensionStore['resolve'] = async (request) => {
    const existing = await lookup(request);
    if (existing) {return existing;}

    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return withFileLock(
      lockPath,
      async () => {
        // Re-check inside the lock: another process may have installed this
        // exact version while we were waiting for it (ADR-0048 "two installs racing").
        const raced = await lookup(request);
        return raced ?? install(request);
      },
      options.lock,
    );
  };

  const listEntries: IExtensionStore['listEntries'] = async () => {
    let dirs: string[];
    try {
      dirs = await fs.readdir(entriesDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {return [];}
      throw err;
    }
    const entries: StoreEntry[] = [];
    for (const dir of dirs) {
      const entry = await readStoreEntry(join(entriesDir, dir, 'entry.json'));
      if (entry) {entries.push(entry);}
    }
    return entries;
  };

  return { root, casDir, entriesDir, lookup, resolve, listEntries };
}
