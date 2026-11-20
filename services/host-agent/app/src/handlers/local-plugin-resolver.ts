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
import { DiagnosticCollector, readMarketplaceLock } from '@kb-labs/core-discovery';
import { createExtensionStore } from '@kb-labs/core-extension-store';
import { canonicalizeProjectPath, deriveProjectId } from '@kb-labs/core-project-registry';
import { getHandlerPermissions, isManifestV3, type PluginContextDescriptor } from '@kb-labs/plugin-contracts';
import { resolveCliHandlerPath } from '@kb-labs/core-platform';

export interface ResolvedPlugin {
  pluginRoot: string;
  handlerPath: string;
}

export interface PluginInventoryEntry {
  id: string;
  version: string;
  root: string;
}

export interface MarketplaceExecutionRequest {
  projectId: string;
  pluginId: string;
  commandPath: string;
  requestId: string;
  executionId: string;
  input: unknown;
}

export interface HostMarketplacePolicy {
  approvedPins: Array<{ package: string; version: string; integrity: string }>;
}

export interface ResolvedMarketplaceExecution extends ResolvedPlugin {
  descriptor: PluginContextDescriptor;
  projectRoot: string;
}

interface ManifestEntry {
  id: string;
  version: string;
  root: string;
}

export class LocalPluginResolver {
  private cache = new Map<string, ManifestEntry>();
  private scanned = false;

  constructor(
    private readonly allowedPaths: string[],
    private readonly marketplacePolicy: HostMarketplacePolicy = { approvedPins: [] },
  ) {}

  /** Resolve an approved Marketplace command without installing or trusting client paths. */
  async resolveMarketplace(request: MarketplaceExecutionRequest): Promise<ResolvedMarketplaceExecution> {
    if (!request.projectId || !request.pluginId || !request.commandPath.trim()) {
      throw new Error('Marketplace execution requires projectId, pluginId, and commandPath');
    }

    const matchingRoots: string[] = [];
    for (const configuredPath of this.allowedPaths) {
      try {
        const canonical = await canonicalizeProjectPath(configuredPath);
        if (deriveProjectId(canonical) === request.projectId) matchingRoots.push(canonical);
      } catch {
        // A stale or inaccessible agent workspace cannot authorize execution.
      }
    }
    const uniqueRoots = [...new Set(matchingRoots)];
    if (uniqueRoots.length !== 1) {
      throw new Error(uniqueRoots.length === 0
        ? 'Project is not managed by this Host Agent'
        : 'Project binding is ambiguous on this Host Agent');
    }
    const projectRoot = uniqueRoots[0]!;
    const lock = await readMarketplaceLock(projectRoot, new DiagnosticCollector(), 'project');
    const pin = lock?.plugins[request.pluginId];
    if (!pin || !pin.enabled || pin.source !== 'marketplace' || pin.package !== request.pluginId || !pin.integrity) {
      throw new Error(`Marketplace plugin is not enabled and pinned in the project: ${request.pluginId}`);
    }
    if (!this.marketplacePolicy.approvedPins.some((approved) => approved.package === request.pluginId
      && approved.version === pin.version && approved.integrity === pin.integrity)) {
      throw new Error(`Marketplace plugin pin is not approved by Host Agent policy: ${request.pluginId}@${pin.version}`);
    }

    const stored = await createExtensionStore().lookup({
      name: request.pluginId,
      version: pin.version,
      expectedIntegrity: pin.integrity,
    });
    if (!stored || stored.entry.kind !== 'plugin' || stored.entry.name !== request.pluginId || stored.entry.version !== pin.version) {
      throw new Error(`Pinned Marketplace plugin is not present in the local extension store: ${request.pluginId}@${pin.version}`);
    }
    const manifest = stored.entry.manifest;
    if (!manifest || !isManifestV3(manifest) || manifest.id !== request.pluginId || manifest.version !== pin.version) {
      throw new Error(`Stored plugin manifest does not match the project pin: ${request.pluginId}@${pin.version}`);
    }
    const commands = manifest.cli?.commands.filter((command) => command.path === request.commandPath) ?? [];
    if (commands.length !== 1) throw new Error(`Marketplace command is missing or ambiguous: ${request.commandPath}`);

    const command = commands[0]!;
    const [handlerReference, exportName] = command.handler.split('#', 2);
    if (!handlerReference || command.handler.split('#').length > 2 || (command.handler.includes('#') && !exportName)) {
      throw new Error(`Marketplace command has an invalid handler declaration: ${request.commandPath}`);
    }
    const pluginRoot = await realpath(stored.packageRoot);
    const resolvedHandler = resolveCliHandlerPath(pluginRoot, command.handler);
    const realHandler = await realpath(resolvedHandler);
    if (!realHandler.startsWith(pluginRoot + sep) || !(await stat(realHandler)).isFile()) {
      throw new Error('Marketplace handler is not a regular file inside the installed package');
    }

    const input = request.input && typeof request.input === 'object'
      ? request.input as { argv?: unknown; flags?: unknown }
      : {};
    const descriptor: PluginContextDescriptor = {
      hostType: 'cli',
      hostContext: {
        host: 'cli',
        binaryName: 'kb',
        argv: Array.isArray(input.argv) ? input.argv.filter((arg): arg is string => typeof arg === 'string') : [],
        flags: input.flags && typeof input.flags === 'object' && !Array.isArray(input.flags)
          ? input.flags as Record<string, unknown>
          : {},
      },
      permissions: getHandlerPermissions(manifest, 'cli', request.commandPath),
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      handlerId: request.commandPath,
      requestId: request.requestId,
      executionId: request.executionId,
    };
    return {
      pluginRoot,
      handlerPath: exportName ? `${realHandler}#${exportName}` : realHandler,
      projectRoot,
      descriptor,
    };
  }

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
