/**
 * @kb-labs/cli-commands/registry
 *
 * CLI adapter over core-discovery. There is exactly one discovery pipeline
 * (marketplace locks of the platform and project scope, plus the pnpm workspace
 * as a development source); this module only maps its result to the shape the
 * CLI registry registers. It scans nothing itself.
 */

import type { DiscoveryResult as CoreDiscoveryResult, DiscoveredPlugin, DiagnosticEvent, IEntityRegistry, ManifestV3 } from '@kb-labs/plugin-contracts';
import type { CommandManifest, DiscoveryResult } from './types';
import { manifestToCommands, createUnavailableManifest } from './manifest-commands';
import { toPosixPath } from '../utils/path';

// Discovery errors always go to stderr; warnings are opt-in. Neither affects --json output.
const DEBUG_MODE = process.env.DEBUG_SANDBOX === '1' || process.env.KB_DISCOVERY_DEBUG === '1';

function pluginToResult(
  plugin: DiscoveredPlugin,
  manifest: ManifestV3,
  diagnostics: DiagnosticEvent[],
): DiscoveryResult {
  let manifests: CommandManifest[];
  try {
    manifests = manifestToCommands(manifest, plugin.packageName, toPosixPath(plugin.packageRoot));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const existing = diagnostics.find(event => event.code === 'COMMAND_SCHEMA_INVALID' && event.context?.pluginId === plugin.id);
    const remediation = existing?.remediation
      ?? `Correct the command schema in ${plugin.packageName}, rebuild it, and run "kb marketplace plugins doctor --scope ${plugin.scope}".`;
    if (!existing) {
      diagnostics.push({
        severity: 'error',
        code: 'COMMAND_SCHEMA_INVALID',
        message: `Plugin "${plugin.id}" command schema is invalid: ${message}`,
        context: { pluginId: plugin.id, entityKind: 'cli-command' },
        ts: Date.now(),
        remediation,
      });
    }
    manifests = [createUnavailableManifest(plugin.packageName, existing?.message ?? message, plugin.id, 'COMMAND_SCHEMA_INVALID', remediation)];
  }
  const handlerFailure = diagnostics.find(event => event.severity === 'error'
    && (event.code === 'COMMAND_HANDLER_MISSING' || event.code === 'COMMAND_HANDLER_UNREADABLE')
    && event.context?.pluginId === plugin.id);
  if (handlerFailure && manifests[0]?.unavailableDiagnostic === undefined) {
    manifests = [createUnavailableManifest(
      plugin.packageName,
      handlerFailure.message,
      plugin.id,
      handlerFailure.code,
      handlerFailure.remediation,
    )];
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
      results.push(pluginToResult(plugin, manifest, discovered.diagnostics));
    }
  }

  for (const failure of discovered.failures) {
    const diagnosticCode = failure.diagnosticCode
      ?? discovered.diagnostics.find(event => event.context?.pluginId === failure.id && event.severity === 'error')?.code;
    results.push({
      manifests: [createUnavailableManifest(
        failure.packageName,
        failure.message,
        failure.id,
        diagnosticCode,
        failure.remediation,
      )],
      source: failure.origin,
      scope: failure.scope,
      packageName: failure.packageName,
      manifestPath: toPosixPath(failure.manifestPath ?? failure.packageRoot),
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
 * @param catalog  The resolved catalog opened by the CLI composition root.
 */
export async function discoverManifestsDetailed(
  catalog: IEntityRegistry,
): Promise<DetailedDiscovery> {
  const discovered = catalog.discovery();

  for (const event of discovered.diagnostics) {
    if (event.severity === 'error' || (DEBUG_MODE && event.severity === 'warning')) {
      console.error(`[discover] ${event.severity} ${event.code}: ${event.message}`);
      if (event.remediation) {
        console.error(`[discover] next: ${event.remediation}`);
      }
    }
  }

  return { results: toDiscoveryResults(discovered), diagnostics: discovered.diagnostics };
}

/** Discover CLI command manifests. See {@link discoverManifestsDetailed}. */
export async function discoverManifests(
  catalog: IEntityRegistry,
): Promise<DiscoveryResult[]> {
  return (await discoverManifestsDetailed(catalog)).results;
}
