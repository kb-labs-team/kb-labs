/**
 * CoreToolPack — wraps the existing tool registry into a ToolPack.
 *
 * This provides backward compatibility: the current 22+ tools continue to
 * work through the new ToolManager, while new packs (kb-labs, MCP) can
 * be added alongside.
 *
 * The pack does NOT re-implement tools — it wraps the existing ToolRegistry.
 */

import type {
  ToolPack,
  PackedTool,
  ToolConflictPolicy,
  ToolPermissions,
  ToolResult,
} from '../../contracts/index.js';

/**
 * Minimal interface matching ToolRegistry from agent-tools.
 * Avoids direct import to keep agent-core independent.
 */
export interface LegacyToolRegistry {
  getDefinitions(): Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  execute(name: string, input: Record<string, unknown>): Promise<ToolResult>;
  getToolNames(): string[];
}

/** Read-only tools that don't mutate state */
const READ_ONLY_TOOLS = new Set([
  'fs_read',
  'fs_list',
  'glob_search',
  'grep_search',
  'find_definition',
  'code_stats',
  'memory_get',
  'memory_preference',
  'memory_constraint',
  'memory_finding',
  'memory_blocker',
  'archive_recall',
  'todo_get',
  'ask_user',
  'ask_parent',
]);

/**
 * Tools safe to execute concurrently (via Promise.all).
 * Criteria: no shared mutable state, no file writes, no side effects.
 * Conservative default: only read-only tools that don't interact with user.
 */
const CONCURRENT_SAFE_TOOLS = new Set([
  'fs_read',
  'fs_list',
  'glob_search',
  'grep_search',
  'find_definition',
  'code_stats',
  'memory_get',
  'archive_recall',
  'todo_get',
]);

/** Tool capability categories */
const TOOL_CAPABILITIES: Record<string, string> = {
  fs_read: 'filesystem',
  fs_write: 'filesystem',
  fs_patch: 'filesystem',
  fs_replace: 'filesystem',
  fs_list: 'filesystem',
  glob_search: 'search',
  grep_search: 'search',
  find_definition: 'search',
  code_stats: 'search',
  shell_exec: 'shell',
  memory_get: 'memory',
  memory_preference: 'memory',
  memory_constraint: 'memory',
  memory_finding: 'memory',
  memory_blocker: 'memory',
  memory_correction: 'memory',
  session_save: 'memory',
  archive_recall: 'memory',
  ask_user: 'interaction',
  ask_parent: 'interaction',
  report: 'interaction',
  task_submit: 'delegation',
  task_status: 'delegation',
  task_collect: 'delegation',
  todo_create: 'organization',
  todo_update: 'organization',
  todo_get: 'organization',
  mass_replace: 'filesystem',
};

/**
 * Create a CoreToolPack from an existing ToolRegistry.
 */
export function createCoreToolPack(registry: LegacyToolRegistry): ToolPack {
  const definitions = registry.getDefinitions();

  const tools: PackedTool[] = definitions.map((def) => {
    const name = def.function.name;
    return {
      definition: def as PackedTool['definition'],
      readOnly: READ_ONLY_TOOLS.has(name),
      concurrencySafe: CONCURRENT_SAFE_TOOLS.has(name),
      capability: TOOL_CAPABILITIES[name] ?? 'general',
      execute: (input: Record<string, unknown>) => registry.execute(name, input),
    };
  });

  return {
    id: 'core',
    namespace: 'core',
    version: '1.0.0',
    priority: 100,
    conflictPolicy: 'override' as ToolConflictPolicy,
    tools,
    capabilities: ['filesystem', 'search', 'shell', 'memory', 'interaction', 'delegation', 'organization'],
    permissions: {
      networkAllowed: true,
      auditTrail: false,
    } as ToolPermissions,
  };
}
