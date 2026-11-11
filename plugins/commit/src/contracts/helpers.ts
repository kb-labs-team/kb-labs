/**
 * Type-safe helper functions for contracts
 * @module @kb-labs/commit/contracts/helpers
 */

import {
  pluginContractsManifest,
  type PluginArtifactIds,
  type PluginCommandIds,
} from "./contract";

/**
 * Get artifact path pattern by ID (type-safe)
 *
 * @example
 * const path = getArtifactPath('commit.plan.json');
 * // Returns: '.kb/commit/current/plan.json'
 */
export function getArtifactPath<T extends PluginArtifactIds>(id: T): string {
  const artifact = pluginContractsManifest.artifacts[id];
  if (!artifact) {
    throw new Error(`Artifact ${String(id)} not found in contracts`);
  }
  return artifact.pathPattern;
}

/**
 * Get artifact metadata by ID (type-safe)
 *
 * @example
 * const artifact = getArtifact('commit.plan.json');
 * // artifact.kind, artifact.description, etc.
 */
export function getArtifact<T extends PluginArtifactIds>(id: T) {
  const artifact = pluginContractsManifest.artifacts[id];
  if (!artifact) {
    throw new Error(`Artifact ${String(id)} not found in contracts`);
  }
  return artifact;
}

/**
 * Check if artifact ID exists in contracts (type-safe)
 *
 * @example
 * if (hasArtifact('commit.plan.json')) {
 *   // TypeScript knows the type!
 * }
 */
export function hasArtifact(id: string): id is PluginArtifactIds {
  return id in pluginContractsManifest.artifacts;
}

/**
 * Get command metadata by ID (type-safe)
 *
 * @example
 * const command = getCommand('commit:generate');
 * // command.description, command.input, command.output, etc.
 */
export function getCommand<T extends PluginCommandIds>(id: T) {
  if (!pluginContractsManifest.commands) {
    throw new Error("Commands not defined in contracts");
  }
  const command = pluginContractsManifest.commands[id];
  if (!command) {
    throw new Error(`Command ${String(id)} not found in contracts`);
  }
  return command;
}

/**
 * Check if command ID exists in contracts (type-safe)
 *
 * @example
 * if (hasCommand('commit:generate')) {
 *   // TypeScript knows the type!
 * }
 */
export function hasCommand(id: string): id is PluginCommandIds {
  return (
    pluginContractsManifest.commands !== undefined &&
    id in pluginContractsManifest.commands
  );
}

/**
 * Type-safe identity function for command IDs (useful for validation)
 *
 * @example
 * const cmdId = getCommandId('commit:generate'); // Compile-time validation!
 */
export function getCommandId<T extends PluginCommandIds>(id: T): T {
  return id;
}

/**
 * Type-safe identity function for artifact IDs (useful for validation)
 *
 * @example
 * const artifactId = getArtifactId('commit.plan.json'); // Compile-time validation!
 */
export function getArtifactId<T extends PluginArtifactIds>(id: T): T {
  return id;
}
