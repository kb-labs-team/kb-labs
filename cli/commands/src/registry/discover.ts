/**
 * @kb-labs/cli-commands/registry
 *
 * CLI adapter over core-discovery. There is exactly one discovery pipeline
 * (marketplace locks of the platform and project scope, plus the pnpm workspace
 * as a development source); this module only maps its result to the shape the
 * CLI registry registers. It scans nothing itself.
 */

import {
  DiscoveryManager,
  type DiscoveryResult as CoreDiscoveryResult,
  type DiscoveredPlugin,
  type DiagnosticEvent,
} from '@kb-labs/core-discovery';
import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import type { CommandManifest, DiscoveryResult } from './types';
import { manifestToCommands, createUnavailableManifest } from './manifest-commands';
import { toPosixPath } from '../utils/path';

// Discovery diagnostics are opt-in and go to stderr so they never pollute --json output.
const DEBUG_MODE = process.env.DEBUG_SANDBOX === '1' || process.env.KB_DISCOVERY_DEBUG === '1';

export interface DiscoverManifestsOptions {
  /** Platform installation root. Defaults to `cwd`. */
  platformRoot?: string;
  /** User project root. Defaults to `cwd`. */
  projectRoot?: string;
}

function pluginToResult(plugin: DiscoveredPlugin, manifest: ManifestV3): DiscoveryResult {
  let manifests: CommandManifest[];
  try {
    manifests = manifestToCommands(manifest, plugin.packageName, toPosixPath(plugin.packageRoot));
  } catch (err: unknown) {
    manifests = [createUnavailableManifest(plugin.packageName, err instanceof Error ? err.message : String(err))];
  }
  return {
    manifests,
    source: plugin.origin,
    scope: plugin.scope,
    packageName: plugin.packageName,
    manifestPath: toPosixPath(plugin.manifestPath),
    pkgRoot: toPosixPath(plugin.packageRoot),
  };
}

/**
 * Map a core-discovery result to CLI discovery results.
 *
 * - Every discovered plugin becomes one result carrying its command manifests.
 * - A candidate whose manifest file exists but failed to load becomes a synthetic
 *   "unavailable" result so `kb <group>` explains the failure instead of vanishing.
 *   Candidates that failed for other reasons (missing package, integrity mismatch,
 *   no manifest) stay diagnostics only.
 *
 * Source priority for shadowing (`workspace` > `linked` > `node_modules`) and the
 * project-over-platform rule are already applied by core-discovery.
 */
export function toDiscoveryResults(discovered: CoreDiscoveryResult): DiscoveryResult[] {
  const results: DiscoveryResult[] = [];

  for (const plugin of discovered.plugins) {
    const manifest = discovered.manifests.get(plugin.id);
    if (manifest) {
      results.push(pluginToResult(plugin, manifest));
    }
  }

  const loadedNames = new Set(discovered.plugins.map(p => p.packageName));
  for (const failure of discovered.failures) {
    if (failure.reason !== 'manifest' || !failure.manifestPath || loadedNames.has(failure.packageName)) {
      continue;
    }
    results.push({
      manifests: [createUnavailableManifest(failure.packageName, failure.message)],
      source: failure.origin,
      scope: failure.scope,
      packageName: failure.packageName,
      manifestPath: toPosixPath(failure.manifestPath),
      pkgRoot: toPosixPath(failure.packageRoot),
    });
  }

  return results;
}

/** Discovery results plus the pipeline's diagnostics (blocked, disabled, integrity, ...). */
export interface DetailedDiscovery {
  results: DiscoveryResult[];
  diagnostics: DiagnosticEvent[];
}

/**
 * Discover CLI command manifests, keeping the pipeline diagnostics.
 *
 * @param cwd      Fallback for both roots.
 * @param options  `platformRoot` (KB_PLATFORM_ROOT) and `projectRoot` (KB_PROJECT_ROOT).
 */
export async function discoverManifestsDetailed(
  cwd: string,
  options: DiscoverManifestsOptions = {},
): Promise<DetailedDiscovery> {
  const platformRoot = options.platformRoot ?? cwd;
  const projectRoot = options.projectRoot ?? cwd;

  const discovered = await new DiscoveryManager({ root: projectRoot, platformRoot }).discover();

  if (DEBUG_MODE) {
    for (const event of discovered.diagnostics) {
      if (event.severity === 'info' || event.severity === 'debug') {continue;}
      console.error(`[discover] ${event.severity} ${event.code}: ${event.message}`);
    }
  }

  return { results: toDiscoveryResults(discovered), diagnostics: discovered.diagnostics };
}

/** Discover CLI command manifests. See {@link discoverManifestsDetailed}. */
export async function discoverManifests(
  cwd: string,
  options: DiscoverManifestsOptions = {},
): Promise<DiscoveryResult[]> {
  return (await discoverManifestsDetailed(cwd, options)).results;
}
