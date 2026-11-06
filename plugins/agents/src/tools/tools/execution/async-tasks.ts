/**
 * Async task tools — fire-and-forget sub-agent operations.
 *
 * - task_submit:  Start a sub-agent in the background, get a task ID immediately
 * - task_status:  Check status of one or all async tasks
 * - task_collect: Wait for a specific task to complete and get its result
 */

import type { ToolContext, Tool } from '../../types.js';
import type { SubAgentPreset } from '../../../contracts/index.js';
import { SUB_AGENT_PRESETS } from '../../config.js';

/**
 * Submit an async task (fire-and-forget sub-agent).
 */
export function createTaskSubmitTool(context: ToolContext): Tool {
  return {
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
            description: {
              type: 'string',
              description: 'Short description of the task (for tracking).',
            },
            task: {
              type: 'string',
              description: 'Detailed task description for the sub-agent.',
            },
            preset: {
              type: 'string',
              enum: ['research', 'execute', 'review'],
              description: 'Sub-agent preset (default: "research").',
            },
            budgetPercent: {
              type: 'number',
              description: 'Percent of remaining budget to allocate (1-100, default: 20).',
            },
          },
          required: ['description', 'task'],
        },
      },
    },
    executor: async (input) => {
      if (!context.taskManager) {
        return {
          success: false,
          error: 'Async task system not available. Task delegation is not enabled for this agent.',
        };
      }

      const description = input.description as string;
      const task = input.task as string;
      const presetId = (input.preset as SubAgentPreset) ?? 'research';
      const preset = SUB_AGENT_PRESETS[presetId];
      if (!preset) {
        return { success: false, error: `Unknown preset: "${presetId}".` };
      }

      const budgetPercent = (input.budgetPercent as number | undefined) ?? 50;
      const budgetFraction = Math.min(1, Math.max(0, budgetPercent / 100));

      try {
        const asyncTask = await context.taskManager.submit(description, {
          task,
          preset: presetId,
          allowedTools: Array.from(preset.tools),
          maxIterations: preset.maxIterations,
          budgetFraction,
        });

        return {
          success: true,
          output: `Task submitted: ${asyncTask.id}\nDescription: ${description}\nPreset: ${presetId}\nStatus: ${asyncTask.status}\n\nUse task_status("${asyncTask.id}") to check progress or task_collect("${asyncTask.id}") to wait for results.`,
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to submit task: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * Check status of async tasks.
 */
export function createTaskStatusTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'task_status',
        description:
          'Check status of one or all async tasks.\n' +
          'Without taskId: returns all tasks.\n' +
          'With taskId: returns details for that specific task.',
        parameters: {
          type: 'object',
          properties: {
            taskId: {
              type: 'string',
              description: 'Specific task ID to check (omit for all tasks).',
            },
          },
          required: [],
        },
      },
    },
    executor: async (input) => {
      if (!context.taskManager) {
        return { success: false, error: 'Async task system not available.' };
      }

      const taskId = input.taskId as string | undefined;
      const result = context.taskManager.getStatus(taskId);

      if (result === null) {
        return { success: false, error: `Task not found: "${taskId}"` };
      }

      const tasks = Array.isArray(result) ? result : [result];
      if (tasks.length === 0) {
        return { success: true, output: 'No async tasks.' };
      }

      const lines = tasks.map(t => {
        const status = t.status === 'completed' ? '✅' :
                       t.status === 'failed' ? '❌' :
                       t.status === 'running' ? '⏳' : '⏸️';
        let line = `${status} ${t.id}: ${t.description} [${t.status}]`;
        if (t.result) { line += `\n   Result: ${t.result.slice(0, 200)}`; }
        if (t.error) { line += `\n   Error: ${t.error}`; }
        return line;
      });

      return { success: true, output: lines.join('\n') };
    },
  };
}

/**
 * Wait for a specific async task to complete and get its full result.
 */
export function createTaskCollectTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'task_collect',
        description:
          'Wait for a specific async task to complete and return its full result.\n' +
          'Blocks until the task is done. Use task_status to check without waiting.',
        parameters: {
          type: 'object',
          properties: {
            taskId: {
              type: 'string',
              description: 'The task ID to wait for.',
            },
          },
          required: ['taskId'],
        },
      },
    },
    executor: async (input) => {
      if (!context.taskManager) {
        return { success: false, error: 'Async task system not available.' };
      }

      const taskId = input.taskId as string;

      try {
        const result = await context.taskManager.collect(taskId);
        const status = result.success ? 'completed successfully' : 'failed';
        const lines = [
          `Task ${taskId} ${status} [preset=${result.preset}, ${result.iterations} iters, ${result.tokensUsed.toLocaleString()} tokens, ${(result.durationMs / 1000).toFixed(1)}s]`,
        ];

        if (result.filesRead.length > 0) { lines.push(`Files read: ${result.filesRead.length}`); }
        if (result.filesModified.length > 0) { lines.push(`Files modified: ${result.filesModified.join(', ')}`); }
        if (result.filesCreated.length > 0) { lines.push(`Files created: ${result.filesCreated.join(', ')}`); }

        lines.push('', result.summary);
        if (result.error) { lines.push('', `Error: ${result.error}`); }

        return { success: result.success, output: lines.join('\n') };
      } catch (error) {
        return {
          success: false,
          error: `Failed to collect task: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
