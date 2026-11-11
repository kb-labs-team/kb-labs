/**
 * AsyncTaskToolPack — ToolPack wrapping task_submit / task_status / task_collect.
 *
 * Created by runner in executeWithTier and registered alongside CoreToolPack.
 * The pack holds a reference to the TaskMiddleware which owns the task registry.
 */

import type { ToolPack, PackedTool, ToolConflictPolicy, ToolResult, ToolPermissions } from '../../contracts/index.js';
import type { SubAgentPreset } from '../../contracts/index.js';
import type { TaskMiddleware } from '../middleware/builtin/task-middleware.js';

// Inline preset config to avoid importing agent-tools from agent-core
const PRESET_MAX_ITERS: Record<string, number> = { research: 50, execute: 100, review: 50 };

export function createAsyncTaskToolPack(taskMw: TaskMiddleware): ToolPack {
  const tools: PackedTool[] = [
    // ── task_submit ─────────────────────────────────────────────────────────
    {
      definition: {
        type: 'function',
        function: {
          name: 'task_submit',
          description:
            'Start a sub-agent task in the background. Returns immediately with a task ID.\n' +
            'The sub-agent runs concurrently — you can continue working while it executes.\n' +
            'Use task_status to check progress or task_collect to wait for results.',
          parameters: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'Short description of the task (for tracking).' },
              task: { type: 'string', description: 'Detailed task description for the sub-agent.' },
              preset: { type: 'string', enum: ['research', 'execute', 'review'], description: 'Sub-agent preset (default: "research").' },
              budgetPercent: { type: 'number', description: 'Percent of remaining budget to allocate (1-100, default: 50).' },
            },
            required: ['description', 'task'],
          },
        },
      },
      readOnly: false,
      capability: 'delegation',
      execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
        const description = input.description as string;
        const task = input.task as string;
        const presetId = (input.preset as SubAgentPreset) ?? 'research';
        const budgetPercent = (input.budgetPercent as number | undefined) ?? 50;
        const budgetFraction = Math.min(1, Math.max(0, budgetPercent / 100));

        try {
          const asyncTask = await taskMw.submit(description, {
            task,
            preset: presetId,
            maxIterations: PRESET_MAX_ITERS[presetId] ?? 15,
            budgetFraction,
          });
          return {
            success: true,
            output: `Task submitted: ${asyncTask.id}\nDescription: ${description}\nPreset: ${presetId}\nStatus: ${asyncTask.status}\n\nUse task_status("${asyncTask.id}") to check or task_collect("${asyncTask.id}") to wait.`,
          };
        } catch (error) {
          return { success: false, error: `Failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    },

    // ── task_status ─────────────────────────────────────────────────────────
    {
      definition: {
        type: 'function',
        function: {
          name: 'task_status',
          description: 'Check status of one or all async tasks. Without taskId: returns all tasks.',
          parameters: {
            type: 'object',
            properties: {
              taskId: { type: 'string', description: 'Specific task ID (omit for all tasks).' },
            },
            required: [],
          },
        },
      },
      readOnly: true,
      capability: 'delegation',
      execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
        const taskId = input.taskId as string | undefined;
        const result = taskMw.getStatus(taskId);
        if (result === null) {
          return { success: false, error: `Task not found: "${taskId}"` };
        }
        const tasks = Array.isArray(result) ? result : [result];
        if (tasks.length === 0) {
          return { success: true, output: 'No async tasks.' };
        }
        const lines = tasks.map(t => {
          const icon = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : t.status === 'running' ? '⏳' : '⏸️';
          let line = `${icon} ${t.id}: ${t.description} [${t.status}]`;
          if (t.result) { line += `\n   Result: ${t.result.slice(0, 200)}`; }
          if (t.error) { line += `\n   Error: ${t.error}`; }
          return line;
        });
        return { success: true, output: lines.join('\n') };
      },
    },

    // ── task_collect ────────────────────────────────────────────────────────
    {
      definition: {
        type: 'function',
        function: {
          name: 'task_collect',
          description: 'Wait for a specific async task to complete and return its full result. Blocks until done.',
          parameters: {
            type: 'object',
            properties: {
              taskId: { type: 'string', description: 'The task ID to wait for.' },
            },
            required: ['taskId'],
          },
        },
      },
      readOnly: true,
      capability: 'delegation',
      execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
        const taskId = input.taskId as string;
        try {
          const r = await taskMw.collect(taskId);
          const status = r.success ? 'completed successfully' : 'failed';
          const lines = [
            `Task ${taskId} ${status} [preset=${r.preset}, ${r.iterations} iters, ${r.tokensUsed.toLocaleString()} tokens, ${(r.durationMs / 1000).toFixed(1)}s]`,
          ];
          if (r.filesRead.length > 0) { lines.push(`Files read: ${r.filesRead.length}`); }
          if (r.filesModified.length > 0) { lines.push(`Files modified: ${r.filesModified.join(', ')}`); }
          if (r.filesCreated.length > 0) { lines.push(`Files created: ${r.filesCreated.join(', ')}`); }
          lines.push('', r.summary);
          if (r.error) { lines.push('', `Error: ${r.error}`); }
          return { success: r.success, output: lines.join('\n') };
        } catch (error) {
          return { success: false, error: `Failed to collect: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    },
  ];

  return {
    id: 'async-tasks',
    namespace: 'async-tasks',
    version: '1.0.0',
    priority: 90,
    conflictPolicy: 'skip' as ToolConflictPolicy,
    tools,
    capabilities: ['delegation'],
    permissions: { networkAllowed: false, auditTrail: false } as ToolPermissions,
  };
}
