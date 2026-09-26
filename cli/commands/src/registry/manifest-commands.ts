/**
 * @kb-labs/cli-commands/registry
 * Maps a plugin's ManifestV3 (as returned by core-discovery) to CLI command manifests.
 */

import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import type { CommandManifest, CommandModule } from './types';
import { validateManifests, normalizeManifest } from './schema';

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

/**
 * Prefer namespace from ManifestV3.id (e.g., '@kb-labs/release' -> 'release').
 * Fallback to package name heuristic if id is missing.
 */
function getNamespaceFromManifest(manifest: ManifestV3 | undefined, packageName: string): string {
  const manifestId = manifest?.id;
  if (typeof manifestId === 'string' && manifestId.length > 0) {
    // take last segment after slash, drop leading '@'
    const seg = manifestId.split('/').pop() || manifestId;
    return seg.replace(/^@/, '');
  }
  const parts = packageName.split('/');
  const last = parts[parts.length - 1] || packageName;
  return last.replace(/^@/, '');
}

/**
 * Validate that command IDs and aliases are unique within a package.
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
 * Convert the `cli.commands` of a plugin manifest into CLI command manifests.
 * Throws when command ids or aliases collide inside the package.
 */
export function manifestToCommands(manifest: ManifestV3, pkgName: string, pkgRoot: string): CommandManifest[] {
  const namespace = getNamespaceFromManifest(manifest, pkgName);
  const cliCommands = Array.isArray(manifest.cli?.commands) ? manifest.cli.commands : [];

  const commandManifests: CommandManifest[] = cliCommands.map((cmd) => {
    const segments = cmd.path.trim().split(/\s+/).filter(Boolean);
    const commandId = segments[segments.length - 1] ?? namespace;
    return {
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
      manifestV2: manifest,
      pkgRoot,
    };
  });

  const validation = validateManifests(commandManifests);
  const valid = validation.success ? validation.data : commandManifests;
  const commands = valid.map(m => normalizeManifest(m, pkgName));
  validateUniqueIds(commands, pkgName);
  return commands;
}

/**
 * Synthetic manifest marking a package as unavailable with an actionable hint.
 * Used when a package's manifest file exists but could not be loaded.
 */
export function createUnavailableManifest(pkgName: string, reason: string): CommandManifest {
  // Try to extract missing module name from the reason
  let missing: string | null = null;
  const m1 = reason.match(/Cannot find (?:module|package) '([^']+)'/);
  const m2 = reason.match(/from ['"]([^'"]+)['"]/);
  if (m1 && m1[1]) {missing = m1[1];}
  else if (m2 && m2[1] && m2[1].startsWith('@')) {missing = m2[1];}

  // Derive group from package name (e.g., @kb-labs/core-cli -> core)
  const seg = pkgName.includes('/') ? pkgName.split('/')[1] : pkgName;
  const group = (seg || pkgName).replace(/-cli$/, '');
  const short = seg || pkgName;

  const unavailableId = `manifest:${short}`;
  return {
    manifestVersion: '1.0',
    segments: [group, unavailableId],
    id: unavailableId,
    group,
    describe: `Commands from ${pkgName} are unavailable`,
    requires: missing ? [missing] : [],
    loader: async () => {
      throw new Error(`Cannot load ${pkgName} CLI manifest. ${reason}`);
    },
    _synthetic: true,
  };
}
