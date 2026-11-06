/**
 * @module @kb-labs/core-runtime/platform-sync
 * Reconciles the filesystem with `.kb/marketplace.lock`.
 *
 * Two modes:
 *
 * - **validate** — check every entry exists and integrity matches. Never
 *   installs. Used in dev/monorepo and for `--dry-run`.
 * - **reconcile** — same as validate, but missing `source: "marketplace"`
 *   entries are installed via the supplied `PackageInstaller`. Used at
 *   Docker build time (and eventually by `kb-create`).
 *
 * `auto` mode picks `validate` when the workspace looks like a monorepo
 * (has `pnpm-workspace.yaml` or `.gitmodules`) and `reconcile` otherwise.
 *
 * Sync never writes to `marketplace.lock` itself. The lock is a declarative
 * source of truth, mutated only by explicit user intent (`kb marketplace
 * install/uninstall/update`). Local-integrity drift (which is common in
 * dev because `package.json` changes frequently in linked packages) is
 * silently ignored — `DiscoveryManager.refreshLocalIntegrity()` handles
 * that separately on actual discovery.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { IEntityRegistry, MarketplaceLock } from '@kb-labs/plugin-contracts';
import type { ILogger } from '@kb-labs/core-platform';
import {
  createPnpmInstaller,
  type PackageInstaller,
} from './platform-sync-installer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlatformSyncMode = 'validate' | 'reconcile' | 'auto';

export interface PlatformSyncOptions {
  /** Resolved platform catalog shared with the caller's process composition. */
  catalog: IEntityRegistry;
  /** Workspace root where `.kb/marketplace.lock` lives */
  root: string;
  /**
   * Mode:
   * - `validate`  — check-only, never install
   * - `reconcile` — install missing `source: "marketplace"` entries
   * - `auto`      — detect monorepo → validate, otherwise reconcile
   *
   * Default: `auto`.
   */
  mode?: PlatformSyncMode;
  /**
   * When true, never install even in reconcile mode. Drift is still
   * reported and makes the result `ok: false`.
   */
  dryRun?: boolean;
  /**
   * Installer used when sync decides to install a missing entry.
   * Default: `createPnpmInstaller()`.
   */
  installer?: PackageInstaller;
  /** Logger. Defaults to a silent logger. */
  logger?: ILogger;
}

export interface PlatformSyncError {
  packageId: string;
  message: string;
}

export interface PlatformSyncResult {
  /** True when nothing was missing, nothing mismatched, nothing errored */
  ok: boolean;
  /** Number of entries examined */
  checked: number;
  /** Entries declared in the lock but absent on disk */
  missing: string[];
  /** Entries whose package.json hash doesn't match the lock (marketplace source only) */
  mismatched: string[];
  /** Entries newly installed by this run (reconcile mode only) */
  installed: string[];
  /** Errors encountered during install (reconcile mode only) */
  errors: PlatformSyncError[];
  /** Mode that was actually used (after `auto` resolution) */
  mode: 'validate' | 'reconcile';
  /** True when no lock file was present (treated as `ok: true, checked: 0`) */
  lockMissing: boolean;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function platformSync(
  options: PlatformSyncOptions,
): Promise<PlatformSyncResult> {
  const root = path.resolve(options.root);
  const logger = options.logger ?? createSilentLogger();
  const dryRun = options.dryRun ?? false;

  const resolvedMode = await resolveMode(root, options.mode ?? 'auto');
  const effectiveMode: 'validate' | 'reconcile' =
    dryRun && resolvedMode === 'reconcile' ? 'validate' : resolvedMode;

  const result: PlatformSyncResult = {
    ok: true,
    checked: 0,
    missing: [],
    mismatched: [],
    installed: [],
    errors: [],
    mode: effectiveMode,
    lockMissing: false,
  };

  const lock = (await options.catalog.marketplaceLocks()).get(root) ?? null;
  if (!lock) {
    result.lockMissing = true;
    return result;
  }

  const entries = [...Object.entries(lock.plugins), ...Object.entries(lock.adapters ?? {})];
  result.checked = entries.length;

  const installer =
    effectiveMode === 'reconcile'
      ? options.installer ?? createPnpmInstaller()
      : null;

  for (const [packageId, entry] of entries) {
    if (entry.enabled === false) {
      // Disabled entries are intentionally not on disk; nothing to reconcile.
      continue;
    }

    const entryPath = entry.resolvedPath ?? entry.link;
    if (!entryPath) {
      result.missing.push(packageId);
      result.ok = false;
      result.errors.push({ packageId, message: `platform lock entry ${packageId} has no resolvedPath` });
      continue;
    }
    const absPath = path.resolve(root, entryPath);
    const present = await pathExists(path.join(absPath, 'package.json'));

    if (!present) {
      if (effectiveMode === 'validate') {
        result.missing.push(packageId);
        result.ok = false;
        logger.warn?.(`platform-sync: missing package ${packageId} (${entryPath})`);
        continue;
      }

      // reconcile: only marketplace entries can be auto-installed;
      // local entries are a dev-setup problem the user must fix.
      if (entry.source !== 'platform' && entry.source !== 'marketplace') {
        result.missing.push(packageId);
        result.ok = false;
        result.errors.push({
          packageId,
          message:
            `cannot reconcile local entry ${packageId}: ` +
            `path ${entryPath} does not exist. ` +
            `Run DevLink or restore the workspace.`,
        });
        continue;
      }

      try {
        logger.info?.(`platform-sync: installing ${packageId}@${entry.version}`);
        if (!entry.version) {throw new Error(`platform lock entry ${packageId} has no exact version`);}
        await installer!.install({
          root,
          name: packageId,
          version: entry.version,
        });
        result.installed.push(packageId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ packageId, message });
        result.missing.push(packageId);
        result.ok = false;
        logger.error?.(`platform-sync: failed to install ${packageId}: ${message}`);
      }
      continue;
    }

    // Package is present — verify integrity.
    // Local entries are expected to drift (editing the linked package mutates
    // package.json), so we don't treat that as a failure here. Real verification
    // happens in DiscoveryManager at discovery time.
    if (entry.source !== 'platform') {
      continue;
    }

    // Schema v3 requires an integrity pin; this guard protects against malformed
    // in-memory locks supplied by callers that bypassed the shared reader.
    if (!entry.integrity) {
      logger.warn?.(
        `platform-sync: no integrity for ${packageId} — skipping verification`,
      );
      continue;
    }

    let computed: string;
    try {
      computed = await options.catalog.computePackageIntegrity(absPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ packageId, message });
      result.ok = false;
      continue;
    }

    if (computed !== entry.integrity) {
      result.mismatched.push(packageId);
      result.ok = false;
      logger.warn?.(
        `platform-sync: integrity mismatch for ${packageId}: expected ${entry.integrity}, got ${computed}`,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveMode(
  root: string,
  mode: PlatformSyncMode,
): Promise<'validate' | 'reconcile'> {
  if (mode !== 'auto') {
    return mode;
  }

  const monorepoMarkers = ['pnpm-workspace.yaml', '.gitmodules'];
  for (const marker of monorepoMarkers) {
    if (await pathExists(path.join(root, marker))) {
      return 'validate';
    }
  }
  return 'reconcile';
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function createSilentLogger(): ILogger {
  const noop = () => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    debug: noop,
    trace: noop,
    flush: async () => {},
    child: () => createSilentLogger(),
  };
}
