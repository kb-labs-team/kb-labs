/**
 * @kb-labs/cli-commands/registry
 * Type definitions for the plugin system
 */

import type { CliFlagDecl, ManifestV3 } from '@kb-labs/plugin-contracts';
import type { DiscoveryOrigin, DiscoveryScope } from '@kb-labs/plugin-contracts';

export interface CommandManifest {
  manifestVersion: '1.0';
  /** Canonical routing key — full path segments, e.g. ['clickup', 'task', 'search'] */
  segments: readonly string[];
  /** Last segment — e.g. 'search' */
  id: string;
  /** First segment — e.g. 'clickup' */
  group: string;
  /** Second segment when depth >= 3 — e.g. 'task' */
  subgroup?: string;
  aliases?: string[];
  category?: string;
  /** One-line description shown in group help (under 50 chars, no trailing period). */
  describe: string;
  longDescription?: string;
  requires?: string[];
  flags?: FlagDefinition[];
  examples?: string[];
  loader?: () => Promise<CommandModule>;
  package?: string;
  engine?: {
    node?: string;
    kbCli?: string;
    module?: 'esm' | 'cjs';
  };
  permissions?: string[];
  telemetry?: 'opt-in' | 'off';
  v3Manifest?: ManifestV3;
  pkgRoot?: string;
  /** Internal flag: true for synthetic "unavailable" manifests (the manifest file exists but failed to load). */
  _synthetic?: boolean;
  /** Synthetic entry retained for a locked workspace plugin that needs a build. */
  unavailablePlugin?: boolean;
  unavailableDiagnostic?: { code: string; remediation: string };
  /** Archetype from manifest — drives automatic flag injection and --schema generation. */
  operationType?: 'read' | 'mutate' | 'execute' | 'analyze';
}

/** Registry reads this after runtime validation; choices stay visible to presentation consumers. */
export type FlagDefinition = CliFlagDecl & { choices?: readonly string[]; describe?: string; examples?: string[] };

export interface RegisteredCommand {
  manifest: CommandManifest;
  available: boolean;
  unavailableReason?: string;
  hint?: string;
  source: DiscoveryOrigin | 'builtin';
  scope?: DiscoveryScope; // Scope the manifest was discovered in (see ADR-0012)
  shadowed: boolean;         // True if overridden by higher priority
  pkgRoot?: string;          // Package root directory (for workspace/linked plugins)
  packageName?: string;       // Full package name
}

export interface CommandModule {
  run: (ctx: unknown, argv: string[], flags: Record<string, unknown>) => Promise<number | void>;
}

/** Commands of one discovered plugin, as produced by the core-discovery adapter. */
export interface DiscoveryResult {
  /** Origin, also the shadowing priority: workspace > linked > node_modules. */
  source: DiscoveryOrigin;
  /** Scope the plugin was discovered in (ADR-0012). */
  scope: DiscoveryScope;
  packageName: string;
  manifestPath: string;      // Absolute manifest path (POSIX): static JSON or compiled module
  pkgRoot: string;           // Absolute package directory (POSIX)
  manifests: CommandManifest[];
}

export interface GlobalFlags {
  json?: boolean;
  onlyAvailable?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  help?: boolean;
  version?: boolean;
  dryRun?: boolean;  // Global --dry-run flag for simulating commands
}

export type AvailabilityCheck = 
  | { available: true }
  | { available: false; reason: string; hint?: string }
