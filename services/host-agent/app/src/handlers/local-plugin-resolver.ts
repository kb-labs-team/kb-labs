/**
 * LocalPluginResolver — resolves pluginId → local handler path on Workspace Agent.
 *
 * Scans workspacePaths for plugin manifests, caches the mapping.
 * Workspace Agent owns path resolution — Platform sends pluginId, not paths.
 *
 * Security:
 * - Paths validated against allowedPaths
 * - No '..' or symlink escape
 * - handlerRef normalized and resolved relative to pluginRoot
 *
 * @see ADR-0017: Workspace Agent Architecture (INV-1: plugin executes where files are)
 */

import { resolve, normalize, join, sep } from 'node:path';
import { readdir, readFile, stat, realpath } from 'node:fs/promises';

export interface ResolvedPlugin {
  pluginRoot: string;
  handlerPath: string;
}

export interface PluginInventoryEntry {
  id: string;
  version: string;
  root: string;
}

interface ManifestEntry {
  id: string;
  version: string;
  root: string;
}

export class LocalPluginResolver {
  private cache = new Map<string, ManifestEntry>();
  private scanned = false;

  constructor(private readonly allowedPaths: string[]) {}

  /**
   * Resolve pluginId + handlerRef → absolute paths.
   * Scans allowedPaths for manifests on first call (cached).
   */
  async resolve(pluginId: string, handlerRef: string): Promise<ResolvedPlugin> {
    if (!this.scanned) {
      await this.scan();
    }

    const entry = this.cache.get(pluginId);
    if (!entry) {
      throw new Error(`Plugin not found: ${pluginId}. Available: [${[...this.cache.keys()].join(', ')}]`);
    }

    // Validate handlerRef: no traversal
    const normalized = normalize(handlerRef);
    if (normalized.startsWith('..') || normalized.includes(`..${sep}`)) {
      throw new Error(`Invalid handlerRef (path traversal): ${handlerRef}`);
    }

    const handlerPath = resolve(entry.root, normalized);

    // Verify file exists first
    try {
      await stat(handlerPath);
    } catch {
      throw new Error(`Handler file not found: ${handlerPath}`);
    }

    // Ensure resolved path is within pluginRoot (no symlink escape)
    // Use realpath to resolve symlinks on both sides before comparison
    const realHandler = await realpath(handlerPath);
    const realRoot = await realpath(entry.root);
    if (!realHandler.startsWith(realRoot + sep) && realHandler !== realRoot) {
      throw new Error(`Handler path escapes plugin root: ${handlerPath}`);
    }

    return { pluginRoot: entry.root, handlerPath };
  }

  /**
   * Return plugin inventory for hello message / discover capability.
   */
  async listPlugins(): Promise<PluginInventoryEntry[]> {
    if (!this.scanned) {
      await this.scan();
    }
    return [...this.cache.values()].map(e => ({
      id: e.id,
      version: e.version,
      root: e.root,
    }));
  }

  /**
   * Force rescan (e.g., after plugin install).
   */
  async rescan(): Promise<void> {
    this.cache.clear();
    this.scanned = false;
    await this.scan();
  }

  /**
   * Scan allowedPaths for plugin manifests.
   * Looks for dist/manifest.json or manifest.json in directories.
   */
  private async scan(): Promise<void> {
    for (const basePath of this.allowedPaths) {
      await this.scanDir(resolve(basePath));
    }
    this.scanned = true;
  }

  private async scanDir(dir: string): Promise<void> {
    // Check if dir itself has a manifest
    await this.tryLoadManifest(dir);

    // Scan subdirectories (one level deep — workspace packages)
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') {
        continue;
      }
      const fullPath = join(dir, entry);
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          await this.tryLoadManifest(fullPath);

          // Also check packages/ subdirectory (monorepo layout)
          const pkgDir = join(fullPath, 'packages');
          try {
            const pkgEntries = await readdir(pkgDir);
            for (const pkg of pkgEntries) {
              if (pkg.startsWith('.')) { continue; }
              const pkgPath = join(pkgDir, pkg);
              const pkgStat = await stat(pkgPath).catch(() => null);
              if (pkgStat?.isDirectory()) {
                await this.tryLoadManifest(pkgPath);
              }
            }
          } catch {
            // no packages/ dir — skip
          }
        }
      } catch {
        continue;
      }
    }
  }

  private async tryLoadManifest(dir: string): Promise<void> {
    // Try dist/manifest.json first (built), then manifest.json (source)
    for (const manifestPath of [join(dir, 'dist', 'manifest.json'), join(dir, 'manifest.json')]) {
      try {
        const raw = await readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(raw) as { id?: string; version?: string; schema?: string };

        if (manifest.id && manifest.version) {
          this.cache.set(manifest.id, {
            id: manifest.id,
            version: manifest.version,
            root: dir,
          });
          return;
        }
      } catch {
        // no manifest here — continue
      }
    }
  }
}
