/**
 * @kb-labs/cli-commands/registry
 * Command manifest discovery - workspace, node_modules, current package
 */

import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { computeManifestIntegrity } from '@kb-labs/core-discovery';
import { manifestCachePath } from './manifest-cache-path';

/** Very small repo root detector: looks for .git upwards. */
function _detectRepoRoot(start = process.cwd()): string {
  let cur = path.resolve(start);
  while (true) {
    if (existsSync(path.join(cur, '.git'))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      return start;
    } // fallback
    cur = parent;
  }
}
import { parse as parseYaml } from 'yaml';
import { glob } from 'glob';
import type { CommandManifest, CommandModule, DiscoveryResult, CacheFile, PackageCacheEntry } from './types';

// Bump this when discovery logic changes to force cache invalidation across all users.
// Last bump: added discoverWorkspace(projectRoot) for prod-mode two-root discovery.
const DISCOVERY_VERSION = 2;
import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import { toPosixPath } from '../utils/path';
import { validateManifests, normalizeManifest } from './schema';

// Check if DEBUG_MODE is enabled
// A development build is not the same thing as an opted-in discovery
// diagnostic session. Keep routine CLI output quiet even when the installed
// Studio/CLI happens to run with NODE_ENV=development.
const DEBUG_MODE = process.env.DEBUG_SANDBOX === '1' || process.env.KB_DISCOVERY_DEBUG === '1';

// Helper function for logging - only outputs in DEBUG_MODE to avoid polluting user output
// In production, discovery logs are suppressed unless user explicitly enables --debug
const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void => {
  if (!DEBUG_MODE) {return;}

  // All discovery logs go to stderr — never stdout — so they don't pollute --json output
  const prefix = level === 'error' ? '✗' : level === 'warn' ? '⚠' : level === 'info' ? 'ℹ' : '🔍';

  if (fields) {
    console.error(`${prefix} [discover] ${message}`, fields);
  } else {
    console.error(`${prefix} [discover] ${message}`);
  }
};

const _SETUP_COMMAND_FLAGS = [
  {
    name: 'force',
    type: 'boolean' as const,
    description: 'Overwrite existing configuration and files.',
  },
  {
    name: 'dry-run',
    type: 'boolean' as const,
    description: 'Preview setup changes without writing to disk.',
  },
  {
    name: 'yes',
    type: 'boolean' as const,
    description: 'Auto-confirm modifications outside the .kb/ directory.',
  },
  {
    name: 'kb-only',
    type: 'boolean' as const,
    description: 'Restrict setup to .kb/ paths and skip project files.',
  },
] satisfies Exclude<CommandManifest['flags'], undefined>;

/**
 * Create loader stub for ManifestV3 commands.
 * Loader should never be executed directly – CLI adapters must handle execution.
 */
function createManifestV3Loader(commandId: string): () => Promise<CommandModule> {
  return async (): Promise<CommandModule> => {
    throw new Error(
      `Loader should not be called for ManifestV3 command ${commandId}. Use plugin-adapter-cli executeCommand instead.`
    );
  };
}

// Setup rollback command removed — setup-engine eliminated from project

/**
 * Ensure manifest has loader function (rehydrate after JSON serialization).
 */
function ensureManifestLoader(manifest: CommandManifest): void {
  if (typeof manifest.loader !== 'function') {
    const commandId = manifest.id || manifest.group || 'unknown';
    log('debug', `[plugins][cache] Rehydrated loader for ${commandId}`);
    manifest.loader = createManifestV3Loader(commandId);
  }
}

export const __test = {
  ensureManifestLoader,
  createManifestV3Loader,
  // resetInProcCache is exported directly (not via __test) since it's part of the public API
  loadCache,
  saveCache,
  computeMarketplaceLockHashAt,
};

/**
 * Thrown by loadManifest when a file is a valid manifest of a non-plugin
 * schema (e.g. kb.service/1). Discovery should skip these silently — they
 * are not errors, just a different manifest type.
 */
class NonPluginManifestError extends Error {
  readonly schema: string;
  constructor(pkgName: string, schema: string) {
    super(`${pkgName} uses manifest schema "${schema}", not kb.plugin/3 — skipping`);
    this.name = 'NonPluginManifestError';
    this.schema = schema;
  }
}

/** Create a synthetic manifest marking package as unavailable with actionable hint */
function createUnavailableManifest(pkgName: string, error: unknown): CommandManifest {
  const rawMsg = (error instanceof Error ? error.message : String(error) || '').toString();
  // Try to extract missing module name from error
  let missing: string | null = null;
  const m1 = rawMsg.match(/Cannot find (?:module|package) '([^']+)'/);
  const m2 = rawMsg.match(/from ['"]([^'"]+)['"]/);
  if (m1 && m1[1]) {missing = m1[1];}
  else if (m2 && m2[1] && m2[1].startsWith('@')) {missing = m2[1];}

  // Derive group from package name (e.g., @kb-labs/core-cli -> core)
  const seg = pkgName.includes('/') ? pkgName.split('/')[1] : pkgName;
  const group = (seg || pkgName).replace(/-cli$/,'');
  const short = seg || pkgName;

  const requires = missing ? [missing] : [];

  const unavailableId = `manifest:${short}`;
  const manifest: CommandManifest = {
    manifestVersion: '1.0',
    segments: [group, unavailableId],
    id: unavailableId,
    group,
    describe: `Commands from ${pkgName} are unavailable`,
    requires,
    loader: async () => {
      // Throw a descriptive error if someone tries to run it
      throw new Error(`Cannot load ${pkgName} CLI manifest. ${rawMsg}`);
    },
    // Mark as synthetic so saveCache can skip it — synthetic manifests must never
    // be persisted to disk because they represent transient load failures.
    // Caching them would make the error "stick" until the TTL expires even after
    // the underlying problem (missing build artifact, broken dep) is resolved.
    _synthetic: true,
  };
  return manifest;
}

// Constants
const PACKAGE_JSON = 'package.json';
const MANIFEST_LOAD_TIMEOUT = 1500; // 1.5 seconds
const IN_PROC_CACHE_TTL_MS = 60_000;
const DISK_CACHE_TTL_MS = 5 * 60_000;

let inProcDiscoveryCache: { timestamp: number; results: DiscoveryResult[] } | null = null;

/**
 * Reset the in-process discovery cache.
 * Call this after clearing the disk cache so the next discoverManifests() call
 * in the same process performs a fresh scan rather than serving stale results.
 */
export function resetInProcCache(): void {
  inProcDiscoveryCache = null;
}


/**
 * Compute hash of lockfile (pnpm-lock.yaml) for cache invalidation
 */
async function computeLockfileHash(cwd: string): Promise<string> {
  const lockfilePath = path.join(cwd, 'pnpm-lock.yaml');
  try {
    const content = await fs.readFile(lockfilePath, 'utf8');
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Compute hash of kb.config.json for cache invalidation
 */
async function computeConfigHash(cwd: string): Promise<string> {
  const configPath = path.join(cwd, '.kb', 'kb.config.json');
  try {
    const content = await fs.readFile(configPath, 'utf8');
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Compute hash of .kb/plugins.json for cache invalidation
 */
async function computePluginsStateHash(cwd: string): Promise<string> {
  const pluginsPath = path.join(cwd, '.kb', 'plugins.json');
  try {
    const content = await fs.readFile(pluginsPath, 'utf8');
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Compute hash of `<root>/.kb/marketplace.lock` for cache invalidation.
 *
 * Each scope (platform, project) has its own lock — the discovery cache
 * tracks both, and a change in either invalidates the cache. The lock is
 * the source of truth for installed/linked plugins, so when it changes
 * (via `kb marketplace plugins link`, `install`, `uninstall`, or
 * `kb scaffold plugin` auto-registering a freshly scaffolded plugin), the
 * CLI cache must be rebuilt so new commands become visible on next invocation.
 */
async function computeMarketplaceLockHashAt(root: string): Promise<string> {
  const lockPath = path.join(root, '.kb', 'marketplace.lock');
  try {
    const content = await fs.readFile(lockPath, 'utf8');
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Detect whether new workspace packages with manifests appeared since cache was written.
 * If so, cached results are considered stale to ensure new commands are registered.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
async function detectNewWorkspacePackages(
  cwd: string,
  cachedPackages: Record<string, PackageCacheEntry> | undefined
): Promise<boolean> {
  if (!cachedPackages) {
    return true;
  }

  try {
    const workspaceYaml = path.join(cwd, 'pnpm-workspace.yaml');
    const content = await fs.readFile(workspaceYaml, 'utf8');
    const parsed = parseYaml(content) as { packages?: string[] };
    if (!Array.isArray(parsed.packages)) {
      return false;
    }

    const knownPackages = new Set(Object.keys(cachedPackages));

    for (const pattern of parsed.packages) {
      const pkgPattern = path.join(pattern, PACKAGE_JSON);
      const pkgFiles = await glob(pkgPattern, {
        cwd,
        absolute: false,
        ignore: ['.kb/**', 'node_modules/**', '**/node_modules/**'],
      });

      for (const pkgFile of pkgFiles) {
        const pkgRoot = path.dirname(path.join(cwd, pkgFile));
        const pkg = await readPackageJson(path.join(cwd, pkgFile));
        if (!pkg || !pkg.name) {
          continue;
        }

        if (knownPackages.has(pkg.name as string)) {
          continue;
        }

        const manifestInfo = await findManifestPath(pkgRoot, pkg);
        if (manifestInfo.path) {
          log('debug', `[plugins][cache] New workspace package detected: ${pkg.name as string}`);
          return true;
        }
      }
    }
  } catch (error: unknown) {
    log('debug', `[plugins][cache] Workspace scan skipped: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  return false;
}

/**
 * Load manifest with timeout protection
 */
async function loadManifestWithTimeout(manifestPath: string, pkgName: string, pkgRoot?: string): Promise<CommandManifest[]> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Timeout')), MANIFEST_LOAD_TIMEOUT);
  });
  
  try {
    return await Promise.race([loadManifest(manifestPath, pkgName, pkgRoot), timeout]);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Timeout') {
      log('warn', `Timeout loading manifest from ${pkgName}`);
      return [];
    }
    throw err;
  }
}

/**
 * Prefer namespace from ManifestV3.id (e.g., '@kb-labs/release' -> 'release').
 * Fallback to package name heuristic if id is missing.
 */
function getNamespaceFromManifest(manifestV2: ManifestV3 | undefined, packageName: string): string {
  const manifestId = manifestV2?.id;
  if (typeof manifestId === 'string' && manifestId.length > 0) {
    // take last segment after slash, drop leading '@'
    const seg = manifestId.split('/').pop() || manifestId;
    return seg.replace(/^@/, '');
  }
  // Fallback: derive from package name (last path segment without org scope)
  const parts = packageName.split('/');
  const last = parts[parts.length - 1] || packageName;
  return last.replace(/^@/, '');
}

// TODO V3: V2 setup command manifest generators removed - V3 uses SetupSpec in manifest
// function createSetupCommandManifest({
//   manifestV2,
//   namespace,
//   pkgName,
//   pkgRoot,
// }: SetupCommandFactoryInput): CommandManifest {
//   const setupId = `${namespace}:setup`;
//   const describe =
//     manifestV2.setup?.describe ||
//     `Initialize ${manifestV2.display?.name || manifestV2.id || namespace}`;

//   const setupManifest: CommandManifest = {
//     manifestVersion: '1.0',
//     id: setupId,
//     group: namespace,
//     describe,
//     flags: SETUP_COMMAND_FLAGS,
//     examples: [
//       `kb ${namespace} setup`,
//       `kb ${namespace} setup --dry-run`,
//     ],
//     loader: () =>
//       loadSetupCommandModule({
//         manifestV2,
//         namespace,
//         pkgName,
//         pkgRoot,
//       }),
//     package: pkgName,
//     namespace,
//   };

//   return setupManifest;
// }

// function createSetupRollbackCommandManifest({
//   manifestV2,
//   namespace,
//   pkgName,
//   pkgRoot,
// }: SetupCommandFactoryInput): CommandManifest {
//   const rollbackId = `${namespace}:setup:rollback`;
//   const describe = `Rollback setup changes for ${manifestV2.display?.name || manifestV2.id || namespace}`;

//   const rollbackManifest: CommandManifest = {
//     manifestVersion: '1.0',
//     id: rollbackId,
//     group: namespace,
//     describe,
//     flags: [
//       {
//         name: 'log',
//         type: 'string' as const,
//         description: 'Path to a setup change log JSON file.',
//       },
//       {
//         name: 'list',
//         type: 'boolean' as const,
//         description: 'List available setup change logs.',
//       },
//       {
//         name: 'yes',
//         type: 'boolean' as const,
//         alias: 'y',
//         description: 'Apply rollback without confirmation prompt.',
//       },
//     ],
//     examples: [
//       `kb ${namespace} setup:rollback --list`,
//       `kb ${namespace} setup:rollback --log .kb/logs/setup/${namespace}-<id>.json --yes`,
//     ],
//     loader: () =>
//       loadSetupRollbackCommandModule({
//         manifestV2,
//         namespace,
//         pkgName,
//         pkgRoot,
//       }),
//     package: pkgName,
//     namespace,
//   };

//   return rollbackManifest;
// }

/**
 * Load manifest - tries ESM first, falls back to CJS
 * Validates and normalizes manifests according to schema
 */
async function loadManifest(manifestPath: string, pkgName: string, pkgRoot?: string): Promise<CommandManifest[]> {
  const fileUrl = pathToFileURL(manifestPath).href;
  const mod = await import(fileUrl);

  const modTyped = mod as { manifest?: unknown; default?: unknown };
  const rawManifest = modTyped.manifest || modTyped.default;
  if (!rawManifest || typeof rawManifest !== 'object') {
    throw new Error(`No manifest export found in ${pkgName}`);
  }
  const schema = (rawManifest as Record<string, unknown>).schema;
  if (schema !== 'kb.plugin/3') {
    throw new NonPluginManifestError(pkgName, typeof schema === 'string' ? schema : String(schema ?? 'unknown'));
  }
  const manifest = rawManifest as ManifestV3;

  const namespace = getNamespaceFromManifest(manifest, pkgName);
  const manifestDir = path.dirname(manifestPath);
  const baseRoot = pkgRoot || manifestDir;
  const cliCommands = Array.isArray(manifest.cli?.commands)
    ? manifest.cli.commands
    : [];
  if (cliCommands.length === 0 && !manifest.setup) {
    log('warn', `ManifestV3 ${manifest.id || pkgName} has no CLI commands or setup entry`);
  }

  const commandManifests: CommandManifest[] = cliCommands.map((cmd) => {
    const segments = cmd.path.trim().split(/\s+/).filter(Boolean);
    const commandId = segments[segments.length - 1] ?? namespace;
    const commandManifest: CommandManifest = {
      manifestVersion: '1.0' as const,
      segments: segments as readonly string[],
      id: commandId,
      group: segments[0] ?? namespace,
      subgroup: segments.length >= 3 ? segments[1] : undefined,
      category: cmd.category,
      describe: cmd.describe || '',
      longDescription: cmd.longDescription,
      aliases: cmd.aliases,
      flags: cmd.flags,
      examples: cmd.examples,
      loader: createManifestV3Loader(cmd.path),
      package: pkgName,
      operationType: cmd.operationType,
    };
    commandManifest.manifestV2 = manifest;
    commandManifest.pkgRoot = baseRoot;
    return commandManifest;
  });

  // TODO V3: V2 setup orchestrator removed - V3 uses SetupSpec in manifest
  // if (manifestV2.setup) {
  //   // Ensure setup/rollback registered under a stable namespace taken from manifest id
  //   const setupNamespace = getNamespaceFromManifest(manifestV2, pkgName);
  //   const setupCommand = createSetupCommandManifest({
  //     manifestV2,
  //     namespace: setupNamespace,
  //     pkgName,
  //     pkgRoot: baseRoot,
  //   });
  //   commandManifests.push(setupCommand);

  //   const rollbackCommand = createSetupRollbackCommandManifest({
  //     manifestV2,
  //     namespace: setupNamespace,
  //     pkgName,
  //     pkgRoot: baseRoot,
  //   });
  //   commandManifests.push(rollbackCommand);
  // }
  
  const validation = validateManifests(commandManifests);
  if (!validation.success) {
    const errorMessages = validation.errors.map(err => 
      err.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(', ')
    ).join('; ');
    log('warn', `ManifestV3 validation warnings for ${pkgName}: ${errorMessages}`);
  }
  
  return (validation.success ? validation.data : commandManifests).map(m =>
    normalizeManifest(m, pkgName)
  );
}

/**
 * Read and parse package.json
 */
async function readPackageJson(pkgPath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await fs.readFile(pkgPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Load kb.config.json with plugins allowlist/blocklist
 */
export async function loadConfig(cwd: string): Promise<{ allow?: string[]; block?: string[]; linked?: string[] }> {
  const configPath = path.join(cwd, '.kb', 'kb.config.json');
  try {
    const content = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(content);
    return {
      allow: config.plugins?.allow,
      block: config.plugins?.block,
      linked: config.plugins?.linked,
    };
  } catch {
    return {};
  }
}

/**
 * Find manifest path using conventional locations
 * Returns path and whether it's deprecated
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
async function findManifestPath(pkgRoot: string, pkg: Record<string, unknown>): Promise<{ path: string | null; deprecated: boolean }> {
  const kb = pkg.kb as Record<string, unknown> | undefined;
  if (kb?.manifest) {
    const manifestPath = path.join(pkgRoot, kb.manifest as string);
    try {
      await fs.access(manifestPath);
      return { path: manifestPath, deprecated: false };
    } catch {
      return { path: null, deprecated: false };
    }
  }

  const exports = pkg.exports as Record<string, unknown> | undefined;
  if (exports?.['./kb/commands']) {
    const exportPath = exports['./kb/commands'] as string | Record<string, string>;
    const manifestPath = typeof exportPath === 'string' ? exportPath : (exportPath as Record<string, string>).default || (exportPath as Record<string, string>).import;
    if (manifestPath) {
      const resolved = path.resolve(pkgRoot, manifestPath);
      try {
        await fs.access(resolved);
        return { path: resolved, deprecated: false };
      } catch {
        const withExt = resolved.endsWith('.js') ? resolved : `${resolved}.js`;
        try {
          await fs.access(withExt);
          return { path: withExt, deprecated: false };
        } catch {}
      }
    }
  }

  return { path: null, deprecated: false };
}

/**
 * Check if package is a plugin by keywords or kb.plugin flag
 */
function isPluginPackage(pkg: Record<string, unknown>): boolean {
  if (!pkg) {return false;}
  
  // Explicit flag
  if ((pkg.kb as Record<string, unknown>)?.plugin === true) {return true;}
  
  // Keyword check
  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords : [];
  return keywords.includes('kb-cli-plugin');
}

/**
 * Validate that command IDs and aliases are unique within a package
 */
function validateUniqueIds(manifests: CommandManifest[], pkgName: string): void {
  const ids = new Set<string>();
  const aliases = new Set<string>();

  for (const m of manifests) {
    const key = m.segments.join('/');
    if (ids.has(key)) {
      throw new Error(`Duplicate command ID "${m.id}" in package ${pkgName}`);
    }
    ids.add(key);
    
    if (m.aliases) {
      for (const alias of m.aliases) {
        if (aliases.has(alias) || ids.has(alias)) {
          throw new Error(`Alias collision "${alias}" in package ${pkgName}`);
        }
        aliases.add(alias);
      }
    }
  }
}

/**
 * Discover commands from workspace packages with parallel loading
 */
async function discoverWorkspace(cwd: string): Promise<DiscoveryResult[]> {
  const workspaceYaml = path.join(cwd, 'pnpm-workspace.yaml');
  const content = await fs.readFile(workspaceYaml, 'utf8');
  const parsed = parseYaml(content) as { packages: string[] };
  
  if (!parsed.packages || !Array.isArray(parsed.packages)) {
    throw new Error('Invalid pnpm-workspace.yaml: missing packages array');
  }
  
  // First pass: collect all package info
  const packageInfos: Array<{pkgRoot: string, pkg: Record<string, unknown>, manifestPath: string}> = [];
  
  for (const pattern of parsed.packages) {
    const pkgPattern = path.join(pattern, PACKAGE_JSON);
    const pkgFiles = await glob(pkgPattern, {
      cwd,
      absolute: false,
      ignore: ['.kb/**', 'node_modules/**', '**/node_modules/**'] // Ignore .kb, node_modules
    });

    for (const pkgFile of pkgFiles) {
      const pkgRoot = path.dirname(path.join(cwd, pkgFile));
      const pkg = await readPackageJson(path.join(cwd, pkgFile));

      if (!pkg) {continue;}

      // Check if package has manifest (explicit or conventional)
      const manifestInfo = await findManifestPath(pkgRoot, pkg);
      if (manifestInfo.path) {
        if (manifestInfo.deprecated) {
          log('warn', `[DEPRECATED] ${pkg.name} uses legacy manifest path: ${manifestInfo.path}`);
          log('warn', `  → Migrate to exports["./kb/commands"] or set kb.commandsManifest in package.json`);
        }
        packageInfos.push({ pkgRoot, pkg, manifestPath: manifestInfo.path });
      }
    }
  }

  // Second pass: load all manifests in parallel. `scope` is platform because
  // `discoverWorkspace` scans pnpm-workspace packages (monorepo dev mode);
  // project-local plugins live under `.kb/plugins/` and are discovered by
  // `discoverProjectLocalPlugins` below.
  return loadManifestsForPackages(packageInfos, 'workspace', 'platform');
}

/**
 * Discover plugins scaffolded into `<projectRoot>/.kb/plugins/<name>/packages/*-entry/`.
 *
 * These are the bread-and-butter of project-scoped installs: a user runs
 * `kb scaffold run plugin demo` inside their project, then `kb marketplace
 * plugins link --scope project ./.kb/plugins/demo/packages/demo-entry`.
 * Their manifests must be picked up even when the project has no
 * `pnpm-workspace.yaml` (installed mode), so this pass is independent from
 * `discoverWorkspace`.
 */
async function discoverProjectLocalPlugins(projectRoot: string): Promise<DiscoveryResult[]> {
  const pattern = path.join('.kb', 'plugins', '*', 'packages', '*-entry', PACKAGE_JSON);
  const files = await glob(pattern, {
    cwd: projectRoot,
    absolute: false,
    ignore: ['**/node_modules/**'],
  });
  const packageInfos: Array<{ pkgRoot: string; pkg: Record<string, unknown>; manifestPath: string }> = [];
  for (const pkgFile of files) {
    const pkgRoot = path.dirname(path.join(projectRoot, pkgFile));
    const pkg = await readPackageJson(path.join(projectRoot, pkgFile));
    if (!pkg) { continue; }
    const manifestInfo = await findManifestPath(pkgRoot, pkg);
    if (manifestInfo.path) {
      packageInfos.push({ pkgRoot, pkg, manifestPath: manifestInfo.path });
    }
  }
  // Project-local plugins use the `linked` source — same as dev-linked
  // packages in node_modules — and carry project scope.
  return loadManifestsForPackages(packageInfos, 'linked', 'project');
}

/**
 * Shared loader used by workspace and project-local discovery. Loads all
 * manifests in parallel with timeout protection and surfaces synthetic
 * "unavailable" manifests on load failure.
 */
async function loadManifestsForPackages(
  packageInfos: Array<{ pkgRoot: string; pkg: Record<string, unknown>; manifestPath: string }>,
  source: DiscoveryResult['source'],
  scope: DiscoveryResult['scope'],
): Promise<DiscoveryResult[]> {
  const loadPromises = packageInfos.map(async ({ pkgRoot, pkg, manifestPath }) => {
    const pkgName = pkg.name as string;
    const pkgStart = Date.now();
    try {
      const manifests = await loadManifestWithTimeout(manifestPath, pkgName, pkgRoot);
      const pkgTime = Date.now() - pkgStart;

      if (pkgTime > 30) {
        log('debug', `[plugins][perf] ${pkgName} manifest parse: ${pkgTime}ms (budget: 30ms)`);
      }

      if (manifests.length > 0) {
        validateUniqueIds(manifests, pkgName);
        return {
          manifests,
          source,
          scope,
          packageName: pkgName,
          manifestPath: toPosixPath(manifestPath),
          pkgRoot: toPosixPath(pkgRoot),
        } satisfies DiscoveryResult;
      }
      return null;
    } catch (err: unknown) {
      const pkgTime = Date.now() - pkgStart;
      log('debug', `[plugins][perf] ${pkgName} failed after ${pkgTime}ms`);
      const errMsg = err instanceof Error ? err.message : String(err);
      const errCode = (err as { code?: string }).code ?? 'UNKNOWN';

      // Non-plugin manifest (e.g. kb.service/1) — not an error, just skip.
      if (err instanceof NonPluginManifestError) {
        log('debug', `[plugins] ${pkgName} skipped: ${err.message}`);
        return null;
      }

      log('warn', JSON.stringify({
        code: 'DISCOVERY_MANIFEST_LOAD_FAIL',
        packageName: pkgName,
        manifestPath: toPosixPath(manifestPath),
        errorCode: errCode,
        errorMessage: errMsg,
        hint: errMsg.includes('Cannot find package')
          ? 'Run: kb devlink apply && pnpm -w build'
          : 'Check manifest syntax and dependencies',
      }));
      const synthetic = createUnavailableManifest(pkgName, err);
      return {
        manifests: [synthetic],
        source,
        scope,
        packageName: pkgName,
        manifestPath: toPosixPath(manifestPath),
        pkgRoot: toPosixPath(pkgRoot),
      } satisfies DiscoveryResult;
    }
  });

  const settledResults = await Promise.allSettled(loadPromises);
  const results: DiscoveryResult[] = [];

  for (const settled of settledResults) {
    if (settled.status === 'fulfilled' && settled.value) {
      results.push(settled.value);
    }
  }

  return results;
}

/**
 * Discover commands from current package (fallback when no workspace)
 */
async function discoverCurrentPackage(cwd: string): Promise<DiscoveryResult | null> {
  try {
    const pkg = await readPackageJson(path.join(cwd, PACKAGE_JSON));
    if (!pkg) {return null;}
    const pkgName = pkg.name as string;

    const manifestInfo = await findManifestPath(cwd, pkg);
    if (manifestInfo.path) {
      if (manifestInfo.deprecated) {
        log('warn', `[DEPRECATED] ${pkgName} uses legacy manifest path: ${manifestInfo.path}`);
        log('warn', `  → Migrate to exports["./kb/commands"] or set kb.commandsManifest in package.json`);
      }
      const manifests = await loadManifestWithTimeout(manifestInfo.path, pkgName, cwd);
      if (manifests.length > 0) {
        validateUniqueIds(manifests, pkgName);
        return {
          manifests,
          source: 'workspace',
          // Current-package fallback fires in installed mode when the user's
          // project itself exposes a manifest. That maps to the project scope.
          scope: 'project',
          packageName: pkgName,
          manifestPath: toPosixPath(manifestInfo.path),
          pkgRoot: toPosixPath(cwd),
        };
      }
    }
  } catch (err: unknown) {
    log('debug', `No CLI manifest in current package: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

/**
 * Discover commands from node_modules with keyword-based discovery
 * Scans all scopes, respects allowlist/blocklist, supports linked plugins
 */
async function discoverNodeModules(cwd: string): Promise<DiscoveryResult[]> {
  const nmDir = path.join(cwd, 'node_modules');
  const config = await loadConfig(cwd);
  
  try {
    const entries = await fs.readdir(nmDir, { withFileTypes: true });
    const packageInfos: Array<{pkgRoot: string, pkg: Record<string, unknown>, manifestPath: string, isLinked?: boolean}> = [];
    
    // First pass: collect all plugin packages
    const scanPromises: Promise<void>[] = [];
    
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {continue;}

      // eslint-disable-next-line sonarjs/cognitive-complexity
      const scanEntry = async () => {
        let pkgRoot: string;
        let pkg: Record<string, unknown> | null = null;

        if (entry.name.startsWith('@')) {
          // Scoped package: @scope/name
          const scopeDir = path.join(nmDir, entry.name);
          try {
            const scopedDirs = await fs.readdir(scopeDir, { withFileTypes: true });
            for (const scopedEntry of scopedDirs.filter(d => d.isDirectory() || d.isSymbolicLink())) {
              pkgRoot = path.join(scopeDir, scopedEntry.name);
              pkg = await readPackageJson(path.join(pkgRoot, PACKAGE_JSON));
              
              if (!pkg) {continue;}

              const scopedPkgName = pkg.name as string | undefined;
              // Check if it's a plugin
              const isPlugin = isPluginPackage(pkg);

              // For @kb-labs/*, always include if has manifest
              // For others, require keyword/flag AND allowlist (unless explicitly blocked)
              if (scopedPkgName?.startsWith('@kb-labs/')) {
                const manifestInfo = await findManifestPath(pkgRoot, pkg);
                if (manifestInfo.path) {
                  packageInfos.push({ pkgRoot, pkg, manifestPath: manifestInfo.path });
                }
              } else if (isPlugin) {
                // 3rd-party plugin: check allowlist/blocklist
                if (config.block?.includes(scopedPkgName ?? '')) {
                  log('debug', `Plugin ${scopedPkgName} blocked by config`);
                  return;
                }

                // Must be allowlisted OR in linked list
                const isAllowlisted = config.allow?.includes(scopedPkgName ?? '') || config.linked?.includes(scopedPkgName ?? '');
                if (!isAllowlisted) {
                  log('debug', `Plugin ${scopedPkgName} skipped (not allowlisted). Add to kb-labs.config.json plugins.allow or enable via 'kb marketplace enable'`);
                  return;
                }

                const manifestInfo = await findManifestPath(pkgRoot, pkg);
                if (manifestInfo.path) {
                  if (manifestInfo.deprecated) {
                    log('warn', `[DEPRECATED] ${scopedPkgName} uses legacy manifest path: ${manifestInfo.path}`);
                    log('warn', `  → Migrate to exports["./kb/commands"] or set kb.commandsManifest in package.json`);
                  }
                  const isLinked = config.linked?.includes(scopedPkgName ?? '');
                  packageInfos.push({ pkgRoot, pkg, manifestPath: manifestInfo.path, isLinked });
                }
              }
            }
          } catch {
            // Scope dir doesn't exist or can't read
          }
        } else {
          // Unscoped package
          pkgRoot = path.join(nmDir, entry.name);
          pkg = await readPackageJson(path.join(pkgRoot, PACKAGE_JSON));
          
          if (!pkg) {return;}

          const unscopedPkgName = pkg.name as string | undefined;
          const isPlugin = isPluginPackage(pkg);

          if (isPlugin) {
            // 3rd-party: check allowlist/blocklist
            if (config.block?.includes(unscopedPkgName ?? '')) {
              log('debug', `Plugin ${unscopedPkgName} blocked by config`);
              return;
            }

            const isAllowlisted = config.allow?.includes(unscopedPkgName ?? '') || config.linked?.includes(unscopedPkgName ?? '');
            if (!isAllowlisted) {
              log('debug', `Plugin ${unscopedPkgName} skipped (not allowlisted). Add to kb-labs.config.json plugins.allow or enable via 'kb marketplace enable'`);
              return;
            }

            const manifestInfo = await findManifestPath(pkgRoot, pkg);
            if (manifestInfo.path) {
              if (manifestInfo.deprecated) {
                log('warn', `[DEPRECATED] ${unscopedPkgName} uses legacy manifest path: ${manifestInfo.path}`);
                log('warn', `  → Migrate to exports["./kb/commands"] or set kb.commandsManifest in package.json`);
              }
              const isLinked = config.linked?.includes(unscopedPkgName ?? '');
              packageInfos.push({ pkgRoot, pkg, manifestPath: manifestInfo.path, isLinked });
            }
          }
        }
      };
      
      scanPromises.push(scanEntry());
    }
    
    await Promise.allSettled(scanPromises);
    
    // Second pass: load all manifests in parallel
    const loadPromises = packageInfos.map(async ({ pkgRoot, pkg, manifestPath, isLinked }) => {
      const pkgName = pkg.name as string;
      try {
        const manifests = await loadManifestWithTimeout(manifestPath, pkgName, pkgRoot);
        if (manifests.length > 0) {
          validateUniqueIds(manifests, pkgName);
          return {
            manifests,
            source: (isLinked ? 'linked' : 'node_modules') as 'node_modules' | 'linked',
            // node_modules discovery runs at the platform root. In dev mode
            // platformRoot === projectRoot so either label is correct; we use
            // platform to reflect where the manifest physically lives.
            scope: 'platform' as const,
            packageName: pkgName,
            manifestPath: toPosixPath(manifestPath),
            pkgRoot: toPosixPath(pkgRoot),
          } satisfies DiscoveryResult;
        }
        return null;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errCode = (err as { code?: string }).code ?? 'UNKNOWN';

        // Non-plugin manifest (e.g. kb.service/1) — not an error, just skip.
        if (err instanceof NonPluginManifestError) {
          log('debug', `[plugins] ${pkgName} skipped: ${err.message}`);
          return null;
        }

        log('warn', JSON.stringify({
          code: 'DISCOVERY_MANIFEST_LOAD_FAIL',
          packageName: pkgName,
          manifestPath: toPosixPath(manifestPath),
          errorCode: errCode,
          errorMessage: errMsg,
          hint: errMsg.includes('Cannot find package')
            ? 'Run: kb devlink apply && pnpm -w build'
            : 'Check manifest syntax and dependencies'
        }));
        const synthetic = createUnavailableManifest(pkgName, err);
        return {
          manifests: [synthetic],
          source: (isLinked ? 'linked' : 'node_modules') as 'node_modules' | 'linked',
          scope: 'platform' as const,
          packageName: pkgName,
          manifestPath: toPosixPath(manifestPath),
          pkgRoot: toPosixPath(pkgRoot),
        } satisfies DiscoveryResult;
      }
    });
    
    const settledResults = await Promise.allSettled(loadPromises);
    const results: DiscoveryResult[] = [];
    
    for (const settled of settledResults) {
      if (settled.status === 'fulfilled' && settled.value) {
        results.push(settled.value);
      }
    }
    
    return results;
  } catch (err: unknown) {
    // node_modules doesn't exist or can't read
    log('debug', `Could not scan node_modules: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Deduplicate manifests by priority: workspace > linked > node_modules
 * Also deduplicate by package path to avoid duplicate workspace packages
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
function deduplicateManifests(all: DiscoveryResult[]): DiscoveryResult[] {
  const byPackageName = new Map<string, DiscoveryResult>();

  // Priority order: workspace > linked > node_modules > builtin
  const priority: Record<string, number> = {
    workspace: 3,
    linked: 2,
    node_modules: 1,
    builtin: 0,
  };

  for (const result of all) {
    const existing = byPackageName.get(result.packageName);
    if (!existing) {
      byPackageName.set(result.packageName, result);
      continue;
    }

    // Cross-scope collision: if the two results point to the same physical
    // directory (dev mode, where `.kb/plugins/...` is matched by both
    // pnpm-workspace and `discoverProjectLocalPlugins`), prefer the project
    // entry — it carries the more precise scope annotation. If the paths
    // differ, project wins — workspace packages override the installed platform.
    if (existing.scope !== result.scope) {
      if (existing.pkgRoot === result.pkgRoot) {
        const projectEntry = existing.scope === 'project' ? existing : result;
        byPackageName.set(result.packageName, projectEntry);
        continue;
      }
      const winner = existing.scope === 'project' ? existing : result;
      const loser = existing.scope === 'project' ? result : existing;
      log('debug', JSON.stringify({
        code: 'DISCOVERY_SCOPE_OVERRIDE',
        packageName: result.packageName,
        projectPath: winner.pkgRoot,
        platformPath: loser.pkgRoot,
        message: 'Package exists in both platform and project scopes — project wins.',
      }));
      byPackageName.set(result.packageName, winner);
      continue;
    }

    // Same scope: keep the higher-priority source.
    const existingPriority = priority[existing.source] ?? 0;
    const newPriority = priority[result.source] ?? 0;
    if (newPriority > existingPriority) {
      byPackageName.set(result.packageName, result);
    }
  }

  return Array.from(byPackageName.values());
}

/**
 * Load cache file. `roots` is matched against the cached `platformRoot` /
 * `projectRoot` — if they drifted (e.g. the user moved the project or
 * KB_PLATFORM_ROOT changed) the cache is considered invalid. This is
 * cheaper than recomputing all manifests blindly and avoids serving stale
 * results from a previous workspace layout.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
async function loadCache(
  cwd: string,
  roots: { platformRoot: string; projectRoot: string },
): Promise<CacheFile | null> {
  // Runtime state lives outside the repository (ADR-0044).
  const cachePath = manifestCachePath(cwd);
  
  try {
    const content = await fs.readFile(cachePath, 'utf8');
    const cache = JSON.parse(content) as Partial<CacheFile> & { mtimes?: unknown; results?: unknown };
    
    // Handle old cache format (with mtimes and results)
    if (cache.mtimes && cache.results) {
      log('debug', 'Old cache format detected, ignoring');
      return null;
    }
    
    // Validate new cache format
    if (!cache.packages) {
      log('debug', 'Invalid cache format, ignoring');
      return null;
    }
    
    // Validate version compatibility
    if (cache.version !== process.version) {
      log('debug', 'Cache invalidated: Node version changed');
      return null;
    }

    if ((cache.discoveryVersion ?? 0) !== DISCOVERY_VERSION) {
      log('debug', `Cache invalidated: discovery logic changed (${cache.discoveryVersion ?? 0} → ${DISCOVERY_VERSION})`);
      return null;
    }

    const currentCliVersion = process.env.CLI_VERSION || '0.1.0';
    if (cache.cliVersion !== currentCliVersion) {
      log('debug', 'Cache invalidated: CLI version changed');
      return null;
    }
    
    // Check lockfile hash. Compare against '' (not the cached field directly)
    // so a missing→present transition (e.g. no lockfile existed when the
    // cache was written) is treated as a real change instead of being
    // skipped by a "both sides truthy" guard — see the marketplace-lock
    // checks below for the same fix and why it matters.
    const currentLockfileHash = await computeLockfileHash(cwd);
    if ((cache.lockfileHash ?? '') !== currentLockfileHash) {
      log('debug', 'Cache invalidated: lockfile changed');
      return null;
    }

    // Check config hash
    const currentConfigHash = await computeConfigHash(cwd);
    if ((cache.configHash ?? '') !== currentConfigHash) {
      log('debug', 'Cache invalidated: kb-labs.config.json changed');
      return null;
    }

    // Check plugins state hash
    const currentPluginsStateHash = await computePluginsStateHash(cwd);
    if ((cache.pluginsStateHash ?? '') !== currentPluginsStateHash) {
      log('debug', 'Cache invalidated: .kb/plugins.json changed');
      return null;
    }

    // Invalidate cache if recorded roots drifted. This covers scenarios like
    // moving the project, renaming the platform dir, or switching scopes.
    if (cache.platformRoot && cache.platformRoot !== roots.platformRoot) {
      log('debug', `Cache invalidated: platformRoot changed (${cache.platformRoot} → ${roots.platformRoot})`);
      return null;
    }
    if (cache.projectRoot && cache.projectRoot !== roots.projectRoot) {
      log('debug', `Cache invalidated: projectRoot changed (${cache.projectRoot} → ${roots.projectRoot})`);
      return null;
    }

    // Check marketplace lock hashes — source of truth for installed/linked
    // plugins. Both scopes are tracked; a change in either invalidates.
    //
    // computeMarketplaceLockHashAt returns '' when the lock file doesn't
    // exist (see its own doc comment), and a brand-new project has no
    // `.kb/marketplace.lock` at all until the first plugin is linked into it
    // (e.g. `kb scaffold run plugin <name>`, which writes the file as part
    // of its own action — see linkWithMarketplace in
    // plugins/scaffold/entry/src/commands/scaffold.ts). The cache written by
    // that same `kb scaffold run` invocation's own startup discovery (which
    // runs BEFORE the scaffold action executes) therefore has
    // projectMarketplaceLockHash===''→undefined. Requiring BOTH sides
    // truthy here made that "no file → file created with the new plugin"
    // transition invisible: undefined && anything is always false, so the
    // check silently no-opped and the newly-scaffolded plugin's commands
    // stayed unregistered until the 5-minute disk-cache TTL expired. Compare
    // against '' instead so presence changes are caught like any other edit.
    const currentPlatformLockHash = await computeMarketplaceLockHashAt(roots.platformRoot);
    if ((cache.platformMarketplaceLockHash ?? '') !== currentPlatformLockHash) {
      log('debug', `Cache invalidated: ${roots.platformRoot}/.kb/marketplace.lock changed`);
      return null;
    }

    if (roots.projectRoot !== roots.platformRoot) {
      const currentProjectLockHash = await computeMarketplaceLockHashAt(roots.projectRoot);
      if ((cache.projectMarketplaceLockHash ?? '') !== currentProjectLockHash) {
        log('debug', `Cache invalidated: ${roots.projectRoot}/.kb/marketplace.lock changed`);
        return null;
      }
    }
    
    const parsedCache = cache as CacheFile;
    parsedCache.ttlMs = parsedCache.ttlMs ?? DISK_CACHE_TTL_MS;
    for (const entry of Object.values(parsedCache.packages) as PackageCacheEntry[]) {
      for (const manifest of entry.result.manifests) {
        ensureManifestLoader(manifest);
      }
      entry.cachedAt = entry.cachedAt ?? parsedCache.timestamp ?? Date.now();
    }
    
    return parsedCache;
  } catch {
    return null; // Cache doesn't exist or is corrupt
  }
}

/**
 * Check if the cache entry for a package is stale.
 *
 * Strategy: mtime as fast path, content hash as confirmation.
 *   - mtime unchanged → not stale (1 stat call, typical case)
 *   - mtime changed   → verify hash (1 readFile + sha256, only on actual changes)
 *   - hash changed    → stale (plugin was rebuilt)
 *   - hash unchanged  → not stale (mtime changed but content identical, e.g. touch)
 *
 * This correctly handles content-addressed build tools that may not update mtime,
 * as well as the common case where mtime and content change together on rebuild.
 */
async function isPackageCacheStale(entry: PackageCacheEntry): Promise<boolean> {
  const manifestFsPath = entry.manifestPath.split('/').join(path.sep);
  const pkgJsonPath = path.join(entry.result.pkgRoot.split('/').join(path.sep), PACKAGE_JSON);

  try {
    const pkgStat = await fs.stat(pkgJsonPath);
    if (pkgStat.mtimeMs !== entry.pkgJsonMtime) {
      log('debug', `Package cache invalidated: package.json changed for ${entry.result.packageName}`);
      return true;
    }
  } catch (error: unknown) {
    log('debug', `Package cache invalidated: missing package.json for ${entry.result.packageName} (${error instanceof Error ? error.message : 'unknown'})`);
    return true;
  }

  let manifestMtimeChanged = false;
  try {
    const manifestStat = await fs.stat(manifestFsPath);
    manifestMtimeChanged = manifestStat.mtimeMs !== entry.manifestMtime;
  } catch (error: unknown) {
    log('debug', `Package cache invalidated: manifest deleted for ${entry.result.packageName} (${error instanceof Error ? error.message : 'unknown'})`);
    return true;
  }

  if (manifestMtimeChanged) {
    try {
      const currentHash = await computeManifestIntegrity(manifestFsPath);
      if (currentHash !== entry.manifestHash) {
        log('debug', `Package cache invalidated: manifest content changed for ${entry.result.packageName}`);
        return true;
      }
    } catch (error: unknown) {
      log('debug', `Package cache hash check failed for ${entry.result.packageName}: ${error instanceof Error ? error.message : 'unknown'}`);
      return true;
    }
  }

  return false;
}

/**
 * Save cache file with per-package structure.
 *
 * The cache lives in the project root — that's where CLI invocations happen
 * and where per-project invalidation hashes belong. `platformRoot` is stored
 * alongside `projectRoot` so the next run can recompute both marketplace-lock
 * hashes, even when the platform root is outside cwd (installed mode).
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
async function saveCache(
  cwd: string,
  results: DiscoveryResult[],
  roots: { platformRoot: string; projectRoot: string },
): Promise<void> {
  const cachePath = manifestCachePath(cwd);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  
  const packages: Record<string, PackageCacheEntry> = {};
  const now = Date.now();
  const stateHasher = createHash('sha256');
  
  // Process each result into package cache entries
  for (const result of results) {
    // Skip results that contain only synthetic unavailable manifests.
    // Synthetic manifests represent transient load failures (missing build
    // artifacts, broken deps) and must not be persisted — caching them would
    // lock the error state until the TTL expires even after the root cause is
    // fixed.
    const allSynthetic = result.manifests.length > 0 &&
      result.manifests.every((m) => m._synthetic === true);
    if (allSynthetic) {
      log('debug', `[plugins][cache] Skipping synthetic unavailable manifest for ${result.packageName}`);
      continue;
    }

    try {
      const manifestHash = await computeManifestIntegrity(result.manifestPath);
      
      // Get package.json mtime and version
      const pkgJsonPath = path.join(result.pkgRoot.split('/').join(path.sep), PACKAGE_JSON);
      const pkgStat = await fs.stat(pkgJsonPath);
      const pkg = await readPackageJson(pkgJsonPath);
      const version = (pkg?.version as string | undefined) || '0.1.0';
      
      // Get manifest mtime
      const manifestStat = await fs.stat(result.manifestPath.split('/').join(path.sep));
      
      const manifestsForCache = result.manifests.map(manifest => {
        const manifestCopy = { ...manifest } as Record<string, unknown>;
        delete manifestCopy.loader;
        return manifestCopy;
      });

      const resultForCache = {
        ...result,
        manifests: manifestsForCache as unknown as CommandManifest[],
      };

      packages[result.packageName] = {
        version,
        manifestHash,
        manifestPath: result.manifestPath,
        pkgJsonMtime: pkgStat.mtimeMs,
        manifestMtime: manifestStat.mtimeMs,
        cachedAt: now,
        result: resultForCache,
      };
      stateHasher.update(result.packageName);
      stateHasher.update(manifestHash);
    } catch (err: unknown) {
      log('debug', `Failed to cache package ${result.packageName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  
  // Compute hashes for invalidation triggers
  const lockfileHash = await computeLockfileHash(cwd);
  const configHash = await computeConfigHash(cwd);
  const pluginsStateHash = await computePluginsStateHash(cwd);
  const platformMarketplaceLockHash = await computeMarketplaceLockHashAt(roots.platformRoot);
  const projectMarketplaceLockHash = roots.projectRoot !== roots.platformRoot
    ? await computeMarketplaceLockHashAt(roots.projectRoot)
    : '';

  if (lockfileHash) { stateHasher.update(lockfileHash); }
  if (configHash) { stateHasher.update(configHash); }
  if (pluginsStateHash) { stateHasher.update(pluginsStateHash); }
  if (platformMarketplaceLockHash) { stateHasher.update(platformMarketplaceLockHash); }
  if (projectMarketplaceLockHash) { stateHasher.update(projectMarketplaceLockHash); }
  stateHasher.update(roots.platformRoot);
  stateHasher.update(roots.projectRoot);

  const cache: CacheFile = {
    version: process.version,
    cliVersion: process.env.CLI_VERSION || '0.1.0',
    discoveryVersion: DISCOVERY_VERSION,
    timestamp: now,
    ttlMs: DISK_CACHE_TTL_MS,
    stateHash: stateHasher.digest('hex'),
    lockfileHash: lockfileHash || undefined,
    configHash: configHash || undefined,
    pluginsStateHash: pluginsStateHash || undefined,
    platformMarketplaceLockHash: platformMarketplaceLockHash || undefined,
    projectMarketplaceLockHash: projectMarketplaceLockHash || undefined,
    platformRoot: roots.platformRoot,
    projectRoot: roots.projectRoot,
    packages,
  };
  
  try {
    // CRITICAL OOM FIX: Use compact JSON to avoid split('\n') memory issues on large manifests (1.6MB+)
    await fs.writeFile(cachePath, JSON.stringify(cache), 'utf8');
  } catch (err: unknown) {
    log('debug', `Failed to save cache: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Main discovery function — discovers command manifests from workspace,
 * current package, and `node_modules`.
 *
 * @param cwd      Project cwd. Used for workspace discovery (monorepo dev mode)
 *                 and for the disk cache location.
 * @param noCache  Bypass both the in-process and disk caches.
 * @param options  Extra options:
 *   - `platformRoot`: When provided, `discoverNodeModules` scans
 *     `<platformRoot>/node_modules` instead of `<cwd>/node_modules`. This is
 *     required in installed mode, where the KB Labs platform lives in a
 *     different directory from the user's project. In dev mode `platformRoot`
 *     typically equals `cwd` and the two paths coincide.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
export async function discoverManifests(
  cwd: string,
  noCache = false,
  options: { platformRoot?: string; projectRoot?: string } = {},
): Promise<DiscoveryResult[]> {
  const startTime = Date.now();
  const timings: Record<string, number> = {};
  const platformRoot = options.platformRoot ?? cwd;
  const projectRoot = options.projectRoot ?? cwd;
  const roots = { platformRoot, projectRoot };

  if (noCache) {
    inProcDiscoveryCache = null;
  } else if (inProcDiscoveryCache) {
    const age = Date.now() - inProcDiscoveryCache.timestamp;
    if (age < IN_PROC_CACHE_TTL_MS) {
      const cachedResults = inProcDiscoveryCache.results;
      const _sourceCounts = cachedResults.reduce((acc, r) => {
        acc[r.source] = (acc[r.source] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      log('debug', `[plugins][discover] in-proc cache hit (${cachedResults.length} packages, age ${age}ms)`);
      return cachedResults;
    }
  }

  // Check cache first
  if (!noCache) {
    const cacheStart = Date.now();
    const cached = await loadCache(cwd, roots);
    timings.cacheLoad = Date.now() - cacheStart;
    
    if (cached) {
      log('debug', 'Using cached manifests');
      // Filter out stale packages and return fresh ones
      const freshResults: DiscoveryResult[] = [];
      const cacheAge = Date.now() - cached.timestamp;
      const ttlMs = cached.ttlMs ?? DISK_CACHE_TTL_MS;

      log('debug', `[plugins][cache] hit age=${cacheAge}ms ttl=${ttlMs}ms`);

      let staleCount = 0;
      for (const entry of Object.values(cached.packages) as PackageCacheEntry[]) {
        const stale = await isPackageCacheStale(entry);
        if (!stale) {
          freshResults.push(entry.result);
        } else {
          staleCount += 1;
        }
      }
      const hasNewWorkspacePackages = await detectNewWorkspacePackages(
        cwd,
        cached.packages,
      );

      if (staleCount === 0 && freshResults.length > 0 && !hasNewWorkspacePackages) {
        const totalTime = Date.now() - startTime;
        const sourceCounts = freshResults.reduce((acc, r) => {
          acc[r.source] = (acc[r.source] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        
        log('info', `[plugins][discover] ${totalTime}ms (cached: ${Object.entries(sourceCounts).map(([s, c]) => `${s}:${c}`).join(', ')})`);
        inProcDiscoveryCache = { timestamp: Date.now(), results: freshResults };
        return freshResults;
      }

      if (hasNewWorkspacePackages) {
        log('debug', '[plugins][cache] invalidated: new workspace packages detected');
      }
      if (staleCount > 0) {
        log('debug', `[plugins][cache] invalidated: ${staleCount} stale package(s) detected`);
      }
    }
  }
  
  // Platform discovery — workspace packages (dev mode) or node_modules
  // (installed mode). Always scanned at `platformRoot`.
  let workspace: DiscoveryResult[] = [];
  try {
    const wsStart = Date.now();
    workspace = await discoverWorkspace(platformRoot);
    timings.workspace = Date.now() - wsStart;
    log('info', `Discovered ${workspace.length} workspace packages with CLI manifests`);
  } catch (_err: unknown) {
    // No pnpm-workspace.yaml - fallback to current package + node_modules
    log('info', 'No workspace file found, checking current package');

    const currentStart = Date.now();
    const currentPkg = await discoverCurrentPackage(cwd);
    timings.currentPackage = Date.now() - currentStart;

    if (currentPkg) {
      workspace = [currentPkg];
      log('info', `Discovered current package with CLI manifest: ${currentPkg.packageName}`);
    }
  }

  const nmStart = Date.now();
  const installed = await discoverNodeModules(platformRoot);
  timings.nodeModules = Date.now() - nmStart;
  if (installed.length > 0) {
    log('info', `Discovered ${installed.length} installed packages with CLI manifests`);
  }

  // Project-local plugins (`.kb/plugins/<name>/packages/*-entry/`). Runs
  // unconditionally against projectRoot so installed and dev modes behave
  // identically. In dev mode projectRoot === platformRoot and the same
  // files may also surface through `discoverWorkspace` (via pnpm-workspace
  // globs); `deduplicateManifests` collapses the duplicates.
  const plStart = Date.now();
  const projectLocal = await discoverProjectLocalPlugins(projectRoot);
  timings.projectLocal = Date.now() - plStart;
  if (projectLocal.length > 0) {
    log('info', `Discovered ${projectLocal.length} project-local plugins`);
  }

  // Project workspace — scan pnpm-workspace.yaml at projectRoot when it differs
  // from platformRoot (prod mode). Results are tagged as scope='project' so
  // deduplicateManifests applies project-wins precedence over platform packages.
  let projectWorkspace: DiscoveryResult[] = [];
  if (roots.projectRoot !== roots.platformRoot) {
    try {
      const pwStart = Date.now();
      const raw = await discoverWorkspace(roots.projectRoot);
      projectWorkspace = raw.map(r => ({ ...r, scope: 'project' as const }));
      timings.projectWorkspace = Date.now() - pwStart;
      if (projectWorkspace.length > 0) {
        log('info', `Discovered ${projectWorkspace.length} project workspace packages with CLI manifests`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isMissingYaml = msg.includes('ENOENT') || msg.includes('no such file');
      if (isMissingYaml) {
        log('debug', `[plugins][discover] no pnpm-workspace.yaml at projectRoot=${roots.projectRoot} — skipping project workspace scan`);
      } else {
        log('warn', JSON.stringify({
          code: 'PROJECT_WORKSPACE_DISCOVERY_FAILED',
          projectRoot: roots.projectRoot,
          error: msg,
          hint: 'Project workspace plugins may be missing from CLI discovery',
        }));
      }
    }
  }

  // Deduplicate (same package from multiple sources/scopes collapses to one,
  // project wins on cross-scope collisions — see deduplicateManifests).
  const dedupStart = Date.now();
  const results = deduplicateManifests([...workspace, ...installed, ...projectLocal, ...projectWorkspace]);
  timings.deduplicate = Date.now() - dedupStart;

  // Save cache
  const saveStart = Date.now();
  await saveCache(cwd, results, roots);
  timings.cacheSave = Date.now() - saveStart;
  
  // Log detailed timings
  const totalTime = Date.now() - startTime;
  const sourceCounts = results.reduce((acc, r) => {
    acc[r.source] = (acc[r.source] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  const timingDetails = Object.entries(timings)
    .filter(([_, t]) => t > 0)
    .map(([k, v]) => `${k}:${v}ms`)
    .join(', ');
  
  log('info', `[plugins][discover] ${totalTime}ms (${Object.entries(sourceCounts).map(([s, c]) => `${s}:${c}`).join(', ')})${timingDetails ? ` | ${timingDetails}` : ''}`);
  
  // Performance budget warnings
  if (totalTime > 150) {
    log('warn', `[plugins][perf] Discovery took ${totalTime}ms (budget: 150ms)`);
  }
  
  inProcDiscoveryCache = { timestamp: Date.now(), results };
  return results;
}

/**
 * Lazy load manifests for a specific namespace
 * Only loads manifests from packages matching the namespace
 */
export async function discoverManifestsByNamespace(
  cwd: string,
  namespace: string,
  noCache = false
): Promise<DiscoveryResult[]> {
  const allResults = await discoverManifests(cwd, noCache);
  
  // Filter by namespace
  return allResults.filter(result => {
    // Check if any manifest in this result matches the namespace
    return result.manifests.some(m => {
      return m.group === namespace;
    });
  });
}
