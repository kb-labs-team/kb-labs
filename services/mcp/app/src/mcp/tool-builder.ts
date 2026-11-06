/**
 * Tool builder — turns plugin manifests into MCP tool descriptors with ZERO
 * hardcoding. Every CLI command declared in a plugin manifest becomes a callable
 * MCP tool, gated by the authorization predicate (Permits) routed through the PDP.
 *
 * Two responsibilities, two functions:
 *   - createToolRegistry(): called ONCE at daemon startup; builds the entity
 *     registry whose snapshot is the source of available commands.
 *   - filterTools(): pure, cheap, per-request; projects a snapshot down to the
 *     tools the calling identity is permitted to use.
 */

import { generateCommandSchema } from '@kb-labs/cli-commands';
import { getHandlerPermissions } from '@kb-labs/plugin-contracts';
import type {
  RegistrySnapshot,
  RegistrySnapshotManifestEntry,
} from '@kb-labs/plugin-contracts';
import type { CliCommandDecl, PermissionSpec } from '@kb-labs/plugin-contracts';
import type { ServiceManifest } from '@kb-labs/plugin-contracts';
import type { ServiceCommandRouteDeclaration } from '@kb-labs/plugin-contracts';
import type { CommandManifest } from '@kb-labs/cli-commands';
import type { Permits } from './authz.js';

/** A single plugin command exposed as an MCP tool, with everything needed to execute it. */
export interface McpTool {
  /** Namespaced, MCP-safe name: `${pluginId}__${command_path_with_underscores}`. */
  name: string;
  description: string;
  inputSchema: object;
  pluginId: string;
  pluginRoot: string;
  handlerPath: string;
  version: string;
  operationType: string | undefined;
  /** Handler permissions, propagated to executeCommandV3 for governance. */
  permissions: PermissionSpec;
}

/** A command that failed to become an MCP tool — malformed manifest, never a fatal error. */
export interface ToolBuildDiagnostic {
  pluginId: string;
  /** decl.id when present, else the raw (possibly missing) path — whatever identifies the command in the manifest. */
  commandId: string;
  error: string;
}

/**
 * Make a plugin ID safe for use in MCP tool names.
 * Strips the leading `@` from scoped npm packages and replaces `/` with `-`.
 * Example: "@kb-labs/commit" → "kb-labs-commit", "my-plugin" → "my-plugin".
 * Case is preserved because plugin IDs like "pluginA" are valid non-scoped names.
 */
function sanitizePluginId(pluginId: string): string {
  return pluginId
    .replace(/^@/, '')              // strip leading @
    .replace(/\//g, '-')            // replace / with -
    .replace(/[^a-zA-Z0-9-]/g, '-'); // replace any other unsafe chars
}

/**
 * Build a collision-safe MCP tool name: `{pluginId}__{command_path}`.
 * The plugin segment is sanitized so npm scope chars (@, /) are removed.
 */
export function mcpToolName(pluginId: string, commandPath: string): string {
  return `${sanitizePluginId(pluginId)}__${commandPath.trim().replace(/\s+/g, '_')}`;
}

/**
 * Adapt a manifest CLI command declaration into the CommandManifest shape that
 * generateCommandSchema consumes. Only the fields the schema generator reads are
 * meaningful here; loader is intentionally absent (schema generation never runs it).
 */
function toCommandManifest(
  decl: CliCommandDecl,
  entry: RegistrySnapshotManifestEntry,
): CommandManifest {
  const segments = decl.path.trim().split(/\s+/).filter(Boolean);
  return {
    manifestVersion: '1.0',
    segments,
    id: segments[segments.length - 1] ?? '',
    group: segments[0] ?? '',
    subgroup: segments.length >= 3 ? segments[1] : undefined,
    describe: decl.describe ?? '',
    longDescription: decl.longDescription,
    aliases: decl.aliases,
    category: decl.category,
    flags: decl.flags,
    examples: decl.examples,
    operationType: decl.operationType,
    package: entry.pluginId,
    v3Manifest: entry.manifest,
    pkgRoot: entry.pluginRoot,
  };
}

/**
 * Build one MCP tool from a command declaration. Throws if the declaration
 * doesn't conform to CliCommandDecl (e.g. missing `path` — seen from manifests
 * scaffolded against an older/wrong shape). Callers decide what to do with a
 * throw; this function never partially mutates shared state.
 */
function buildTool(entry: RegistrySnapshotManifestEntry, decl: CliCommandDecl): McpTool {
  if (typeof decl.path !== 'string' || decl.path.trim().length === 0) {
    throw new Error(
      `command "${(decl as { id?: string }).id ?? '(unknown)'}" in plugin "${entry.pluginId}" has no "path" field — skipping`,
    );
  }
  return {
    name: mcpToolName(entry.pluginId, decl.path),
    description: decl.describe,
    inputSchema: generateCommandSchema(toCommandManifest(decl, entry)),
    pluginId: entry.pluginId,
    pluginRoot: entry.pluginRoot,
    handlerPath: decl.handler,
    version: entry.manifest.version ?? '0.0.0',
    operationType: decl.operationType,
    permissions: getHandlerPermissions(entry.manifest, 'cli', decl.path),
  };
}

export interface McpServiceTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: 'string' | 'boolean' | 'number' | 'array' }>;
    required: string[];
    additionalProperties: false;
  };
  serviceId: string;
  route: ServiceCommandRouteDeclaration;
}

/** Derive project service tools from the enabled service manifests. */
export function buildServiceTools(manifests: readonly ServiceManifest[]): McpServiceTool[] {
  return manifests.flatMap((manifest) => (manifest.commands ?? []).flatMap((command) => {
    if (command.kind === 'local') {return [];}
    return [{
      name: mcpToolName(manifest.id, command.name),
      description: command.description,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(command.flags).map(([key, flag]) => [key, { type: flag.type }])),
        required: Object.entries(command.flags).filter(([, flag]) => flag.required).map(([key]) => key),
        additionalProperties: false,
      },
      serviceId: manifest.id,
      route: command.route,
    }];
  }));
}

/**
 * Project a registry snapshot down to the MCP tools the identity may use.
 * Pure and cheap — safe to call per request. Authorization is delegated entirely
 * to the supplied Permits predicate (PDP seam).
 *
 * A malformed command declaration must never fail the whole tools/list call —
 * it's skipped here. validateManifests() is the place that surfaces it as a
 * diagnostic (logged + queryable), so this stays silent on purpose.
 */
export function filterTools(
  snapshot: Pick<RegistrySnapshot, 'manifests'>,
  permits: Permits,
): McpTool[] {
  const tools: McpTool[] = [];
  for (const entry of snapshot.manifests) {
    for (const decl of entry.manifest.cli?.commands ?? []) {
      if (!permits(decl.operationType, entry.pluginId)) {
        continue;
      }
      try {
        tools.push(buildTool(entry, decl));
      } catch {
        // Recorded by validateManifests() at startup — skip silently here.
      }
    }
  }
  return tools;
}

/**
 * Structural validation of every declared command in the snapshot, independent
 * of any identity's permissions. Run ONCE at startup so broken manifests show
 * up in logs and via /observability/diagnostics before any caller ever hits
 * them — permit-gated filterTools() would otherwise hide them until someone
 * with access to that plugin makes a request.
 */
export function validateManifests(
  snapshot: Pick<RegistrySnapshot, 'manifests'>,
): ToolBuildDiagnostic[] {
  const diagnostics: ToolBuildDiagnostic[] = [];
  for (const entry of snapshot.manifests) {
    for (const decl of entry.manifest.cli?.commands ?? []) {
      try {
        buildTool(entry, decl);
      } catch (error) {
        diagnostics.push({
          pluginId: entry.pluginId,
          commandId: (decl as { id?: string }).id ?? decl.path ?? '(unknown)',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return diagnostics;
}
