/**
 * agent:trace:filter - Filter trace events by type (AI-friendly)
 *
 * Usage:
 *   pnpm kb agent:trace:filter <taskId> --type=llm:call
 *   pnpm kb agent:trace:filter <taskId> --type=tool:execution --json
 *   pnpm kb agent:trace:filter <taskId> --type=error:captured
 */

import { defineCommand, useLogger, type PluginCommandContextV3 } from '@kb-labs/sdk';
import type { CommandResult } from '@kb-labs/sdk';
import type {
  TraceCommandResponse,
  FilterResponse,
  TraceErrorCode,
  DetailedTraceEntry,
  LLMCallEvent,
  ToolExecutionEvent,
  ErrorCapturedEvent,
} from '../../contracts/index.js';
import { loadTrace, formatTraceLoadError } from '../../tracing/index.js';

// Valid event types (includes both new colon-separated and legacy snake_case formats)
const VALID_EVENT_TYPES: string[] = [
  // New format (detailed trace)
  'iteration:detail',
  'llm:call',
  'tool:execution',
  'memory:snapshot',
  'decision:point',
  'synthesis:forced',
  'error:captured',
  'prompt:diff',
  'tool:filter',
  'context:trim',
  'stopping:analysis',
  'llm:validation',
  // Legacy format (simple trace)
  'llm_call',
  'llm_response',
  'tool_call',
  'tool_result',
  'tool_cache_hit',
  'task_start',
  'task_end',
];

type TraceFilterInput = {
  taskId?: string;
  'task-id'?: string;
  type?: string;
  json?: boolean;
};

type TraceFilterResult = CommandResult<TraceCommandResponse>;

export default defineCommand({
  id: 'trace:filter',
  description: 'Filter trace events by type for debugging',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: TraceFilterInput): Promise<TraceFilterResult> {
      const logger = useLogger();
      const flags: TraceFilterInput =
        (typeof input === 'object' && input !== null && 'flags' in input)
          ? (input as { flags: TraceFilterInput }).flags
          : input;
      const taskId = (flags['task-id'] ?? flags.taskId) as string | undefined;
      const eventType = flags.type as string | undefined;

    if (!eventType) {
      const err = error('INVALID_EVENT_TYPE', 'Missing required --type flag');
      ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
      return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: err.error?.message ?? 'The task ID is invalid.', hint: 'Pass a valid task ID with `kb agents trace filter --task-id <id>`.' } };
    }

    if (!VALID_EVENT_TYPES.includes(eventType)) {
      const err = error(
        'INVALID_EVENT_TYPE',
        `Invalid event type: ${eventType}. Valid types: ${VALID_EVENT_TYPES.join(', ')}`
      );
      ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
      return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: err.error?.message ?? 'The trace was not found.', hint: 'Choose an existing trace, then rerun `kb agents trace filter --task-id <id>`.' } };
    }

    try {
      const loaded = await loadTrace(taskId);
      if (!loaded.ok) {
        const code: TraceErrorCode =
          loaded.error.kind === 'invalid_task_id' ? 'INVALID_TASK_ID' :
          loaded.error.kind === 'not_found' ? 'TRACE_NOT_FOUND' :
          loaded.error.kind === 'too_large' ? 'FILE_TOO_LARGE' :
          'CORRUPTED_TRACE';
        const err = error(code, formatTraceLoadError(loaded.error));
        ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
        return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: err.error?.message ?? 'The trace could not be filtered.', hint: 'Check the trace data, then rerun `kb agents trace filter --task-id <id>`.' } };
      }

      const { events } = loaded;

      // Filter by type
      const filtered = events.filter((e) => e.type === eventType);

      // Build response
      const response: TraceCommandResponse<FilterResponse> = {
        success: true,
        command: 'trace:filter',
        taskId: taskId ?? '',
        data: {
          taskId: taskId ?? '',
          eventType: eventType,
          events: filtered,
          count: filtered.length,
        },
        summary: {
          message: `Found ${filtered.length} ${eventType} events`,
          severity: 'info',
          actionable: false,
        },
      };

      // Output
      if (flags.json) {
        ctx.ui.write(JSON.stringify(response, null, 2) + '\n');
      } else {
        printHumanReadable(ctx, eventType, filtered);
      }

      return response;
    } catch (err) {
      logger.error('trace:filter error:', err instanceof Error ? err : undefined);
      const errResponse = error('IO_ERROR', err instanceof Error ? err.message : String(err));
      ctx.ui.write(JSON.stringify(errResponse, null, 2) + '\n');
      return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: errResponse.error?.message ?? 'The trace could not be filtered.', hint: 'Check the trace data, then rerun `kb agents trace filter --task-id <id>`.' } };
    }
    },
  },
});

/**
 * Print human-readable output
 */
function printHumanReadable(ctx: PluginCommandContextV3, eventType: string, events: DetailedTraceEntry[]): void {
  ctx.ui.write('\n');
  ctx.ui.write(`🔍 Filtered Events: ${eventType}\n`);
  ctx.ui.write(`Found ${events.length} events\n`);
  ctx.ui.write('\n');

  if (events.length === 0) {
    ctx.ui.write('No events found.\n');
    return;
  }

  // Show first 10 events
  const showCount = Math.min(10, events.length);
  ctx.ui.write(`Showing first ${showCount}/${events.length}:\n`);
  ctx.ui.write('\n');

  for (let i = 0; i < showCount; i++) {
    const event = events[i];
    if (!event) {continue;}

    ctx.ui.write(`[${event.seq}] ${event.timestamp} (iteration ${'iteration' in event ? event.iteration : 'N/A'})\n`);

    // Show event-specific summary
    if (event.type === 'llm:call') {
      const e = event as LLMCallEvent;
      ctx.ui.write(`  Model: ${e.request.model}, Tokens: ${e.response.usage.totalTokens}, Cost: $${e.cost.totalCost.toFixed(6)}\n`);
    } else if (event.type === 'tool:execution') {
      const e = event as ToolExecutionEvent;
      ctx.ui.write(`  Tool: ${e.tool.name}, Success: ${e.output.success}, Duration: ${e.timing.durationMs}ms\n`);
    } else if (event.type === 'error:captured') {
      const e = event as ErrorCapturedEvent;
      ctx.ui.write(`  Error: ${e.error.message.substring(0, 100)}\n`);
    }

    ctx.ui.write('\n');
  }

  if (events.length > showCount) {
    ctx.ui.write(`... and ${events.length - showCount} more events\n`);
    ctx.ui.write('Use --json flag to see all events\n');
  }
}

/**
 * Create error response
 */
function error(code: TraceErrorCode, message: string): TraceCommandResponse {
  return {
    success: false,
    command: 'trace:filter',
    taskId: '',
    error: {
      code,
      message,
    },
    summary: {
      message,
      severity: 'error',
      actionable: true,
    },
  };
}
