/**
 * @kb-labs/cli-commands/registry
 * Type definitions for the plugin system
 */

import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import type { DiscoveryOrigin, DiscoveryScope } from '@kb-labs/core-discovery';

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
  manifestV2?: ManifestV3;
  pkgRoot?: string;
  /** Internal flag: true for synthetic "unavailable" manifests (the manifest file exists but failed to load). */
  _synthetic?: boolean;
  /** Archetype from manifest — drives automatic flag injection and --schema generation. */
  operationType?: 'read' | 'mutate' | 'execute' | 'analyze';
}

export interface FlagDefinition {
  name: string;              // "profile"
  type: "string" | "boolean" | "number" | "array";
  alias?: string;            // "p" - single letter
  default?: unknown;
  description?: string;
  describe?: string;
  choices?: string[];        // ["dev", "prod"] - only for string type
  required?: boolean;
  examples?: string[];
}

export interface RegisteredCommand {
  manifest: CommandManifest;
  v3Manifest?: ManifestV3;   // Full V3 manifest (clean naming, replaces manifestV2 field)
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

