/**
 * ToolPack contract types for Agent v2 extensible tool system.
 *
 * ToolPack groups tools with namespace, priority, conflict resolution,
 * and permissions. ToolManager registers packs and enforces permissions
 * at a single point.
 */

import type { ToolDefinition, ToolResult } from './types.js';

// ═══════════════════════════════════════════════════════════════════════
// ToolPack
// ═══════════════════════════════════════════════════════════════════════

/**
 * A packaged group of tools with namespace isolation and permissions.
 *
 * Examples:
 *   { id: 'core', namespace: 'core', priority: 100 }
 *   { id: 'kb-labs', namespace: 'kb', priority: 50 }
 *   { id: 'mcp:github', namespace: 'mcp.github', priority: 30 }
 */
export interface ToolPack {
  /** Unique pack identifier */
  readonly id: string;
  /** Namespace prefix for tool resolution (e.g., 'core', 'kb', 'mcp.github') */
  readonly namespace: string;
  /** Semver version */
  readonly version: string;
  /** Higher number = higher priority when overriding conflicting tool names */
  readonly priority: number;
  /** What to do when tool names conflict with another pack */
  readonly conflictPolicy: ToolConflictPolicy;
  /** Tools in this pack */
  readonly tools: PackedTool[];
  /** Declared capabilities (e.g., ['filesystem', 'search', 'shell']) */
  readonly capabilities?: string[];
  /** Permission constraints for this pack's tools */
  readonly permissions?: ToolPermissions;

  /** Whether this pack should be active (checked at registration time) */
  enabled?(): boolean;
  /** Called once after registration */
  initialize?(): Promise<void>;
  /** Called on shutdown */
  dispose?(): Promise<void>;
}

/**
 * A single tool within a ToolPack.
 */
export interface PackedTool {
  /** The OpenAI-compatible function definition */
  readonly definition: ToolDefinition;
  /** Whether this tool only reads state (no side effects) */
  readonly readOnly?: boolean;
  /**
   * Whether this tool is safe to execute concurrently with other concurrent-safe tools.
   * When true, multiple calls can run via Promise.all() in the same iteration.
   * When false (default), tool executes sequentially.
   * Read-only tools are typically concurrent-safe.
   */
  readonly concurrencySafe?: boolean;
  /** Capability category */
  readonly capability?: string;
  /** Execute the tool */
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

// ═══════════════════════════════════════════════════════════════════════
// Conflict Resolution
// ═══════════════════════════════════════════════════════════════════════

/**
 * How to resolve tool name conflicts between packs.
 *
 * - 'error': Throw at registration time (strict mode)
 * - 'override': Higher-priority pack's tool wins, lower is shadowed
 * - 'namespace-prefix': Both tools available as `namespace.toolName`
 */
export type ToolConflictPolicy = 'error' | 'override' | 'namespace-prefix';

// ═══════════════════════════════════════════════════════════════════════
// Permissions
// ═══════════════════════════════════════════════════════════════════════

/**
 * Permission constraints enforced by ToolManager (not by individual tools).
 */
export interface ToolPermissions {
  /** Allowed filesystem paths (glob patterns). Empty = no fs access. */
  allowedPaths?: string[];
  /** Denied shell commands (exact match or prefix). */
  deniedCommands?: string[];
  /** Whether network access is allowed (default: true for core, false for MCP) */
  networkAllowed?: boolean;
  /** Whether all tool calls should be logged to audit trail */
  auditTrail?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// Tool Filter
// ═══════════════════════════════════════════════════════════════════════

/**
 * Filter options for ToolManager.getTools().
 */
export interface ToolFilter {
  /** Only return read-only tools */
  readOnly?: boolean;
  /** Only return tools with this capability */
  capability?: string;
  /** Only return tools from this namespace */
  namespace?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Resolved Tool (internal to ToolManager)
// ═══════════════════════════════════════════════════════════════════════

/**
 * A tool after namespace resolution, ready for execution.
 * Produced by ToolManager.register() and used by ToolManager.execute().
 */
export interface ResolvedTool {
  /** Fully qualified name (may include namespace prefix) */
  readonly qualifiedName: string;
  /** Original short name from definition */
  readonly shortName: string;
  /** Pack this tool belongs to */
  readonly packId: string;
  /** Pack namespace */
  readonly namespace: string;
  /** The tool definition (with possibly updated name) */
  readonly definition: ToolDefinition;
  /** Whether this tool only reads state */
  readonly readOnly: boolean;
  /** Whether this tool is safe to execute concurrently with other concurrent-safe tools */
  readonly concurrencySafe: boolean;
  /** Capability category */
  readonly capability?: string;
  /** Execute the tool */
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}
