/**
 * agent:trace:iteration - View specific iteration details (AI-friendly)
 *
 * Usage:
 *   pnpm kb agent:trace:iteration <taskId> --iteration=3
 *   pnpm kb agent:trace:iteration <taskId> --iteration=5 --json
 */

import { defineCommand, useLogger, type PluginCommandContextV3 } from '@kb-labs/sdk';
import type { CommandResult } from '@kb-labs/sdk';
import type {
  TraceCommandResponse,
  IterationResponse,
  TraceErrorCode,
} from '../../contracts/index.js';
import type { DetailedTraceEntry } from '../../contracts/index.js';
import { loadTrace, formatTraceLoadError } from '../../tracing/index.js';
import { normalizeTraceEvents } from './trace-event-normalizer.js';

type TraceIterationInput = {
  taskId?: string;
  'task-id'?: string;
  iteration?: number;
  json?: boolean;
};

type TraceIterationResult = CommandResult<TraceCommandResponse>;

export default defineCommand({
  id: 'trace:iteration',
  description: 'View all events for a specific iteration',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: TraceIterationInput): Promise<TraceIterationResult> {
      const logger = useLogger();
      const flags = ('flags' in input ? (input as { flags: TraceIterationInput }).flags : input) as TraceIterationInput;
      const taskId = (flags['task-id'] ?? flags.taskId) as string | undefined;
      const iteration = typeof flags.iteration === 'string' ? parseInt(flags.iteration, 10) : (flags.iteration as number | undefined);

    if (iteration === undefined || iteration < 1) {
      const err = error('INVALID_ITERATION', 'Missing or invalid --iteration flag (must be >= 1)');
      ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
      return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: err.error?.message ?? 'The iteration number is invalid.', hint: 'Pass an iteration number of at least 1 with `kb agents trace iteration --iteration <n>`.' } };
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
        return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: err.error?.message ?? 'The trace task ID is invalid.', hint: 'Check the task ID, then rerun `kb agents trace iteration --task-id <id> --iteration <n>`.' } };
      }

      const normalized = normalizeTraceEvents(loaded.events);
      const filtered = normalized.filter((e) => e.iteration === iteration).map((e) => e.raw);

      if (filtered.length === 0) {
        const err = error('INVALID_ITERATION', `No events found for iteration ${iteration}`);
        ctx.ui.write(JSON.stringify(err, null, 2) + '\n');
        return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: err.error?.message ?? `No events were found for iteration ${iteration}.`, hint: 'Choose an iteration that exists in this trace, then rerun `kb agents trace iteration --task-id <id> --iteration <n>`.' } };
      }

      // Calculate summary
      const summary = calculateIterationSummary(filtered);

      // Build response
      const response: TraceCommandResponse<IterationResponse> = {
        success: true,
        command: 'trace:iteration',
        taskId: taskId ?? '',
        data: {
          taskId: taskId ?? '',
          iteration,
          events: filtered,
          summary,
        },
        summary: {
          message: `Iteration ${iteration}: ${summary.eventCount} events, ${summary.llmCalls} LLM calls, ${summary.toolCalls} tool calls`,
          severity: summary.errors > 0 ? 'warning' : 'info',
          actionable: summary.errors > 0,
        },
      };

      // Output
      if (flags.json) {
        ctx.ui.write(JSON.stringify(response, null, 2) + '\n');
      } else {
        printHumanReadable(ctx, iteration, filtered, summary);
      }

      return response;
    } catch (err) {
      logger.error('trace:iteration error:', err instanceof Error ? err : undefined);
      const errResponse = error('IO_ERROR', err instanceof Error ? err.message : String(err));
      ctx.ui.write(JSON.stringify(errResponse, null, 2) + '\n');
      return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: errResponse.error?.message ?? 'The trace iteration could not be read.', hint: 'Check the trace file, then rerun `kb agents trace iteration --task-id <id> --iteration <n>`.' } };
    }
    },
  },
});

/**
 * Calculate iteration summary
 */
function calculateIterationSummary(events: DetailedTraceEntry[]): IterationResponse['summary'] {
  const llmEvents = events.filter((e) => {
    const type = String((e as { type?: unknown }).type ?? '');
    return type === 'llm:start' || type === 'llm:call' || type === 'llm_call';
  });
  const toolEvents = events.filter((e) => {
    const type = String((e as { type?: unknown }).type ?? '');
    return type === 'tool:start' || type === 'tool:execution' || type === 'tool_call';
  });
  const errorEvents = events.filter((e) => {
    const type = String((e as { type?: unknown }).type ?? '');
    return type === 'error:captured' || type === 'agent:error' || type === 'tool:error';
  });

  // Calculate duration (from first to last event timestamp)
  const timestamps = events.map((e) => new Date(e.timestamp).getTime());
  const durationMs = timestamps.length > 0 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;

  return {
    eventCount: events.length,
    llmCalls: llmEvents.length,
    toolCalls: toolEvents.length,
    errors: errorEvents.length,
    durationMs,
  };
}

interface LLMIterationEvent {
  data?: { tokensUsed?: number };
  response?: { usage?: { totalTokens?: number } };
}

interface ToolIterationEvent {
  data?: { toolName?: string };
  tool?: { name?: string };
}

interface ErrorIterationEvent {
  error?: { message?: string };
}

/**
 * Print human-readable output
 */
function printHumanReadable(
  ctx: PluginCommandContextV3,
  iteration: number,
  events: DetailedTraceEntry[],
  summary: IterationResponse['summary']
): void {
  ctx.ui.write('\n');
  ctx.ui.write(`🔄 Iteration ${iteration}\n`);
  ctx.ui.write('\n');

  ctx.ui.write('📊 Summary:\n');
  ctx.ui.write(`  Total events: ${summary.eventCount}\n`);
  ctx.ui.write(`  LLM calls: ${summary.llmCalls}\n`);
  ctx.ui.write(`  Tool calls: ${summary.toolCalls}\n`);
  ctx.ui.write(`  Errors: ${summary.errors}\n`);
  ctx.ui.write(`  Duration: ${summary.durationMs}ms\n`);
  ctx.ui.write('\n');

  ctx.ui.write('📝 Events Timeline:\n');
  ctx.ui.write('\n');

  // Group events by type for better readability
  const grouped = new Map<string, DetailedTraceEntry[]>();
  for (const event of events) {
    const existing = grouped.get(event.type) || [];
    existing.push(event);
    grouped.set(event.type, existing);
  }

  // Show event counts
  for (const [type, typeEvents] of grouped) {
    ctx.ui.write(`  ${type}: ${typeEvents.length}\n`);

    // Show details for important events
    if ((type === 'llm:end' || type === 'llm:call') && typeEvents.length > 0) {
      const llmEvent = typeEvents[0] as unknown as LLMIterationEvent;
      const tokens = llmEvent?.data?.tokensUsed ?? llmEvent?.response?.usage?.totalTokens ?? 0;
      ctx.ui.write(`    Tokens: ${tokens}\n`);
    } else if (type === 'tool:end' || type === 'tool:start' || type === 'tool:execution') {
      const toolNames = (typeEvents as unknown as ToolIterationEvent[]).map((e) => e?.data?.toolName || e?.tool?.name || 'unknown');
      ctx.ui.write(`    Tools: ${[...new Set(toolNames)].join(', ')}\n`);
    } else if (type === 'error:captured' && typeEvents.length > 0) {
      const errorEvent = typeEvents[0] as unknown as ErrorIterationEvent;
      ctx.ui.write(`    ⚠️  ${errorEvent.error?.message?.substring(0, 100) ?? ''}\n`);
    }
  }

  ctx.ui.write('\n');
  ctx.ui.write('Use --json flag to see full event details\n');
}

/**
 * Create error response
 */
function error(code: TraceErrorCode, message: string): TraceCommandResponse {
  return {
    success: false,
    command: 'trace:iteration',
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
