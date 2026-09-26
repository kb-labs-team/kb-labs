/**
 * @kb-labs/cli-commands/registry
 * Manifest validation and registration with shadowing support (ADR-0015)
 *
 * Key changes vs old version:
 *  - canonicalKey = segments.join(':') — includes full path, no subgroup collision
 *  - checkNamespaceCollision removed — Trie guarantees structural uniqueness
 *  - CommandRegistry replaced with TrieBackedRegistry
 */

import type { CommandManifest, DiscoveryResult, RegisteredCommand } from './types';
import type { TrieBackedRegistry } from './service';
import { checkRequires } from './availability';
import type { ILogger } from '@kb-labs/core-platform';
import { platform } from '@kb-labs/core-runtime';
import { getLogLevel } from '@kb-labs/cli-runtime';

export interface RegisterManifestsOptions {
  cwd?: string;
}

// ─── Manifest structural validation ──────────────────────────────────────────

function validateManifestStructure(manifest: CommandManifest): void {
  if (manifest.manifestVersion !== '1.0') {
    throw new Error(
      `Unsupported manifestVersion "${manifest.manifestVersion}" in ${manifest.segments?.join(' ') ?? manifest.id} (expected "1.0")`
    );
  }
  if (!Array.isArray(manifest.segments) || manifest.segments.length === 0) {
    throw new Error(`Missing or empty segments in manifest ${manifest.id}`);
  }
  if (!manifest.describe) {
    throw new Error(`Missing describe in manifest ${manifest.segments.join(' ')}`);
  }
  if (!manifest.loader && !manifest.manifestV2) {
    throw new Error(`Command ${manifest.segments.join(' ')} must have either loader or manifestV2`);
  }
  if (manifest.flags) {
    for (const flag of manifest.flags) {
      if (!flag.name || !flag.type) {
        throw new Error(`Invalid flag in ${manifest.segments.join(' ')}: missing name or type`);
      }
      if (flag.alias && flag.alias.length !== 1) {
        throw new Error(`Flag "${flag.name}" in ${manifest.segments.join(' ')}: alias must be a single character`);
      }
      if (flag.choices && flag.type !== 'string') {
        throw new Error(
          `Flag "${flag.name}" in ${manifest.segments.join(' ')}: choices only allowed for string type`
        );
      }
    }
  }
}

// ─── Source priority ──────────────────────────────────────────────────────────

const SOURCE_PRIORITY: Record<string, number> = {
  builtin: 4,
  workspace: 3,
  linked: 2,
  node_modules: 1,
};

function getSourcePriority(source: string): number {
  return SOURCE_PRIORITY[source] ?? 0;
}

// ─── Preflight ────────────────────────────────────────────────────────────────

export interface SkippedManifest {
  id: string;
  source: string;
  reason: string;
}

export interface ManifestRegistrationResult {
  registered: RegisteredCommand[];
  skipped: SkippedManifest[];
  collisions: number;
  errors: number;
}

export function preflightManifests(
  discoveryResults: DiscoveryResult[],
  logger?: ILogger
): { valid: DiscoveryResult[]; skipped: SkippedManifest[] } {
  const log = logger ?? platform.logger;
  const logLevel = getLogLevel();
  const valid: DiscoveryResult[] = [];
  const skipped: SkippedManifest[] = [];

  for (const result of discoveryResults) {
    const allowed: CommandManifest[] = [];

    for (const manifest of result.manifests) {
      try {
        validateManifestStructure(manifest);
        allowed.push(manifest);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : 'Validation failed';
        const id = manifest?.segments?.join(' ') ?? manifest?.id ?? result.packageName ?? 'unknown';
        skipped.push({ id, source: result.source, reason });
        log.warn(`Preflight skipped manifest ${id}: ${reason}`);
        if (logLevel === 'debug') {
          process.stderr.write(`[debug][preflight] skipped ${id} (${result.source}): ${reason}\n`);
        }
      }
    }

    if (allowed.length > 0) {
      valid.push({ ...result, manifests: allowed });
    }
  }

  return { valid, skipped };
}

// ─── Registration ─────────────────────────────────────────────────────────────

// eslint-disable-next-line sonarjs/cognitive-complexity
export async function registerManifests(
  discoveryResults: DiscoveryResult[],
  registry: TrieBackedRegistry,
  options: RegisterManifestsOptions & { logger?: ILogger } = {}
): Promise<ManifestRegistrationResult> {
  const log = options.logger ?? platform.logger;
  const registered: RegisteredCommand[] = [];
  const skipped: SkippedManifest[] = [];
  // canonicalKey → first registered command (for shadowing logic)
  const globalIds = new Map<string, RegisteredCommand>();
  const logLevel = getLogLevel();

  let collisions = 0;
  let errors = 0;

  const sorted = [...discoveryResults].sort((a, b) => {
    return getSourcePriority(b.source) - getSourcePriority(a.source);
  });

  for (const result of sorted) {
    for (const manifest of result.manifests) {
      const manifestId = manifest.segments?.join(' ') ?? manifest.id ?? 'unknown';

      try {
        try {
          validateManifestStructure(manifest);
        } catch (err: unknown) {
          throw new Error(`Validation failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        const availability = checkRequires(manifest, {
          cwd: options.cwd ?? result.pkgRoot,
        });

        const cmd: RegisteredCommand = {
          manifest,
          v3Manifest: manifest.manifestV2,
          available: availability.available,
          unavailableReason: availability.available ? undefined : availability.reason,
          hint: availability.available ? undefined : availability.hint,
          source: result.source,
          shadowed: false,
          pkgRoot: result.pkgRoot,
          packageName: result.packageName,
        };

        // Canonical key is the full path — unique by construction in the trie
        const canonicalKey = manifest.segments.join(':');
        const existing = globalIds.get(canonicalKey);

        if (existing) {
          // Same path from two sources — apply shadowing by priority
          if (existing.source === result.source && existing.source === 'workspace') {
            collisions++;
            throw new Error(
              `Command path collision: "${manifestId}" exported by multiple workspace packages.`
            );
          }
          const existPri = getSourcePriority(existing.source);
          const curPri = getSourcePriority(result.source);

          if (curPri > existPri) {
            existing.shadowed = true;
            globalIds.set(canonicalKey, cmd);
            if (logLevel === 'info' || logLevel === 'debug') {
              log.info(`${canonicalKey} from ${result.source} shadows ${existing.source} version`);
            }
          } else {
            cmd.shadowed = true;
            if (logLevel === 'info' || logLevel === 'debug') {
              log.info(`${canonicalKey} from ${result.source} shadowed by ${existing.source} version`);
            }
          }
        } else {
          globalIds.set(canonicalKey, cmd);
        }

        if (!cmd.shadowed) {
          registry.registerManifest(cmd);
          registered.push(cmd);
        }
      } catch (error: unknown) {
        errors++;
        const reason = error instanceof Error ? error.message : String(error);
        skipped.push({ id: manifestId, source: result.source, reason });
        log.error(`Skipped manifest ${manifestId} (${result.source}): ${reason}`);
      }
    }
  }

  if (skipped.length > 0) {
    log.warn(`Skipped ${skipped.length} manifest(s) during registration`);
    for (const skip of skipped) {
      log.warn(`  • ${skip.id} [${skip.source}] → ${skip.reason}`);
    }
  }

  return { registered, skipped, collisions, errors };
}
