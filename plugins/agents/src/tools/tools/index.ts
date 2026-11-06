/**
 * Tool registration and exports
 *
 * Tools are organized by category:
 *   filesystem/  — fs_read, fs_write, fs_patch, fs_replace, fs_list, mass_replace
 *   search/      — glob_search, grep_search, find_definition, code_stats
 *   memory/      — memory_*, archive_recall, session_save
 *   planning/    — plan_validate, plan_write, todo_*
 *   execution/   — shell_exec, task_submit/status/collect
 *   interaction/ — ask_user, ask_parent, report
 *   shared/      — tool-error (utilities)
 */

import type { ToolContext } from '../types.js';
import { ToolRegistry } from '../registry.js';

// ── Filesystem ──────────────────────────────────────────────────────────────

import {
  createFsWriteTool,
  createFsReadTool,
  createFsPatchTool,
  createFsReplaceTool,
  createFsListTool,
} from './filesystem/filesystem.js';

import { createMassReplaceTool } from './filesystem/mass-replace.js';

// ── Search ──────────────────────────────────────────────────────────────────

import {
  createGlobSearchTool,
  createGrepSearchTool,
  createListFilesTool,
  createFindDefinitionTool,
  createCodeStatsTool,
} from './search/search.js';

// ── Memory ──────────────────────────────────────────────────────────────────

import {
  createMemoryGetTool,
  createMemoryPreferenceTool,
  createMemoryConstraintTool,
  createSessionSaveTool,
  createMemoryCorrectionTool,
  createMemoryFindingTool,
  createMemoryBlockerTool,
} from './memory/memory.js';

import { createArchiveRecallTool } from './memory/archive-recall.js';

// ── Planning ────────────────────────────────────────────────────────────────

import {
  createTodoCreateTool,
  createTodoUpdateTool,
  createTodoGetTool,
} from './planning/todo.js';

import { createPlanValidateTool } from './planning/plan-validate.js';
import { createPlanWriteTool } from './planning/plan-write.js';

// ── Execution ───────────────────────────────────────────────────────────────

import { createShellExecTool } from './execution/shell.js';
import { createTaskSubmitTool, createTaskStatusTool, createTaskCollectTool } from './execution/async-tasks.js';

// ── Interaction ─────────────────────────────────────────────────────────────

import { createAskUserTool } from './interaction/interaction.js';
import { createAskParentTool, createReportTool } from './interaction/reporting.js';

// ═════════════════════════════════════════════════════════════════════════════
// Registry
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Create and register all tools
 */
export function createToolRegistry(context: ToolContext): ToolRegistry {
  const allowed = context.allowedTools;
  const allow = (name: string) => !allowed || allowed.has(name);
  const registry = new ToolRegistry(context);

  // ── Filesystem ──
  if (allow('fs_write')) {registry.register(createFsWriteTool(context));}
  if (allow('fs_read')) {registry.register(createFsReadTool(context));}
  if (allow('fs_patch')) {registry.register(createFsPatchTool(context));}
  if (allow('fs_replace')) {registry.register(createFsReplaceTool(context));}
  if (allow('fs_list')) {registry.register(createFsListTool(context));}
  if (allow('mass_replace')) {registry.register(createMassReplaceTool(context));}

  // ── Search ──
  if (allow('glob_search')) {registry.register(createGlobSearchTool(context));}
  if (allow('grep_search')) {registry.register(createGrepSearchTool(context));}
  if (allow('find_definition')) {registry.register(createFindDefinitionTool(context));}
  if (allow('code_stats')) {registry.register(createCodeStatsTool(context));}

  // ── Execution ──
  if (allow('shell_exec')) {registry.register(createShellExecTool(context));}
  if (context.taskManager) {
    if (allow('task_submit')) { registry.register(createTaskSubmitTool(context)); }
    if (allow('task_status')) { registry.register(createTaskStatusTool(context)); }
    if (allow('task_collect')) { registry.register(createTaskCollectTool(context)); }
  }

  // ── Memory ──
  if (allow('memory_get')) {registry.register(createMemoryGetTool(context));}
  if (allow('memory_preference')) {registry.register(createMemoryPreferenceTool(context));}
  if (allow('memory_constraint')) {registry.register(createMemoryConstraintTool(context));}
  if (allow('session_save')) {registry.register(createSessionSaveTool(context));}
  if (allow('memory_correction')) {registry.register(createMemoryCorrectionTool(context));}
  if (allow('memory_finding')) {registry.register(createMemoryFindingTool(context));}
  if (allow('memory_blocker')) {registry.register(createMemoryBlockerTool(context));}
  if (context.archiveMemory && allow('archive_recall')) {
    registry.register(createArchiveRecallTool(context));
  }

  // ── Planning ──
  if (allow('todo_create')) {registry.register(createTodoCreateTool(context));}
  if (allow('todo_update')) {registry.register(createTodoUpdateTool(context));}
  if (allow('todo_get')) {registry.register(createTodoGetTool(context));}
  if (allow('plan_validate')) { registry.register(createPlanValidateTool(context)); }
  if (allow('plan_write')) { registry.register(createPlanWriteTool(context)); }

  // ── Interaction ──
  if (allow('ask_user')) {registry.register(createAskUserTool(context));}
  if (allow('ask_parent')) {registry.register(createAskParentTool(context));}
  if (allow('report')) {registry.register(createReportTool(context));}

  return registry;
}

// ═════════════════════════════════════════════════════════════════════════════
// Re-exports
// ═════════════════════════════════════════════════════════════════════════════

export {
  // Filesystem
  createFsWriteTool,
  createFsReadTool,
  createFsPatchTool,
  createFsReplaceTool,
  createFsListTool,
  createMassReplaceTool,
  // Search
  createListFilesTool,
  createGlobSearchTool,
  createGrepSearchTool,
  createFindDefinitionTool,
  createCodeStatsTool,
  // Memory
  createMemoryGetTool,
  createMemoryPreferenceTool,
  createMemoryConstraintTool,
  createSessionSaveTool,
  createMemoryCorrectionTool,
  createMemoryFindingTool,
  createMemoryBlockerTool,
  createArchiveRecallTool,
  // Planning
  createTodoCreateTool,
  createTodoUpdateTool,
  createTodoGetTool,
  createPlanValidateTool,
  createPlanWriteTool,
  // Execution
  createShellExecTool,
  createTaskSubmitTool,
  createTaskStatusTool,
  createTaskCollectTool,
  // Interaction
  createAskUserTool,
  createAskParentTool,
  createReportTool,
};
