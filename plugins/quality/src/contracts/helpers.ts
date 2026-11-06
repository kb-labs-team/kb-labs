/**
 * Type-safe helper functions for contracts
 * @module @kb-labs/plugin-template-contracts/helpers
 */

import {
  pluginContractsManifest,
  type PluginArtifactIds,
  type PluginCommandIds,
  type PluginRouteIds,
} from './contract';

/**
 * Get artifact path pattern by ID (type-safe)
 *
 * @example
 * const path = getArtifactPath('template.hello.greeting');
 * // ✅ Автодополнение работает!
 * // ✅ Проверка на этапе компиляции!
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
 * const artifact = getArtifact('template.hello.greeting');
 * // artifact.kind, artifact.description, и т.д.
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
 * if (hasArtifact('template.hello.greeting')) {
 *   // ✅ Типизировано!
 * }
 */
export function hasArtifact(id: string): id is PluginArtifactIds {
  return id in pluginContractsManifest.artifacts;
}

/**
 * Get command metadata by ID (type-safe)
 *
 * @example
 * const command = getCommand('template:hello');
 * // command.description, command.input, command.output, и т.д.
 */
export function getCommand<T extends PluginCommandIds>(id: T) {
  if (!pluginContractsManifest.commands) {
    throw new Error('Commands not defined in contracts');
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
 * if (hasCommand('template:hello')) {
 *   // ✅ Типизировано!
 * }
 */
export function hasCommand(id: string): id is PluginCommandIds {
  return pluginContractsManifest.commands !== undefined && id in pluginContractsManifest.commands;
}

/**
 * Type-safe identity function for command IDs (useful for validation)
 *
 * @example
 * const cmdId = getCommandId('template:hello'); // ✅ Проверка на этапе компиляции!
 */
export function getCommandId<T extends PluginCommandIds>(id: T): T {
  return id;
}

/**
 * Type-safe identity function for artifact IDs (useful for validation)
 *
 * @example
 * const artifactId = getArtifactId('template.hello.greeting'); // ✅ Проверка!
 */
export function getArtifactId<T extends PluginArtifactIds>(id: T): T {
  return id;
}

/**
 * Get route metadata by ID (type-safe)
 *
 * @example
 * const route = getRoute('template.rest.hello');
 * // route.method, route.path, route.response, и т.д.
 */
export function getRoute<T extends PluginRouteIds>(id: T) {
  if (!pluginContractsManifest.api?.rest?.routes) {
    throw new Error('REST routes not defined in contracts');
  }
  const route = pluginContractsManifest.api.rest.routes[id];
  if (!route) {
    throw new Error(`Route ${String(id)} not found in contracts`);
  }
  return route;
}

/**
 * Check if route ID exists in contracts (type-safe)
 *
 * @example
 * if (hasRoute('template.rest.hello')) {
 *   // ✅ Типизировано!
 * }
 */
export function hasRoute(id: string): id is PluginRouteIds {
  return (
    pluginContractsManifest.api?.rest?.routes !== undefined &&
    id in pluginContractsManifest.api.rest.routes
  );
}

/**
 * Type-safe identity function for route IDs (useful for validation)
 *
 * @example
 * const routeId = getRouteId('template.rest.hello'); // ✅ Проверка!
 */
export function getRouteId<T extends PluginRouteIds>(id: T): T {
  return id;
}

