/**
 * AgentMode — defines a mode of execution (execute, plan, spec, debug, etc.).
 *
 * A mode can:
 *   - Add system prompt instructions
 *   - Filter available tools (e.g. plan mode = read-only)
 *   - Register mode-specific middlewares
 *   - Take full control via execute() and call next() for the standard loop
 *
 * Modes are registered via sdk.withMode(mode) and selected at runtime
 * based on AgentConfig.mode. Multiple modes can be registered;
 * only the matching one is activated.
 */

import type { TaskResult } from '../contracts/index.js';
import type { LLMTool } from '@kb-labs/sdk';
import type { RunContext } from './contexts.js';
import type { AgentMiddleware } from './middleware.js';

// ─────────────────────────────────────────────────────────────────────────────
// ToolFilter — selects which tools are visible in a given mode
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolFilter {
  /** If set, only tools matching these names are included */
  allowNames?: string[];
  /** If set, tools matching these names are excluded */
  denyNames?: string[];
  /** If true, only read-only tools (no filesystem writes, no shell) */
  readOnly?: boolean;
  /** Filter by tool capability tags */
  capabilities?: string[];
}

export type ToolFilterFn = (tool: LLMTool) => boolean;

// ─────────────────────────────────────────────────────────────────────────────
// AgentMode interface
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentMode {
  /** Mode name — matched against AgentConfig.mode */
  name: string;

  /** Extra instructions appended to the system prompt in this mode */
  getSystemPromptAdditions?(): string;

  /** Restricts which tools are visible to the LLM in this mode */
  getToolFilter?(): ToolFilter | ToolFilterFn;

  /** Additional middlewares activated only in this mode */
  getMiddlewares?(): AgentMiddleware[];

  /**
   * Full mode override — mode takes control of execution.
   * Call next() to delegate to the standard LinearExecutionLoop.
   *
   * Use this for modes that wrap the loop (e.g. plan mode: validate → loop → validate).
   */
  execute?(
    task: string,
    ctx: RunContext,
    next: () => Promise<TaskResult>
  ): Promise<TaskResult>;
}
