/**
 * ObservabilityMiddleware — bridges AgentMiddleware hooks to AgentEvent stream.
 *
 * Architecture (bus pattern):
 *   - Lifecycle hooks (beforeLLMCall, afterLLMCall, beforeToolExec, afterToolExec)
 *     emit into ctx.run.eventBus — infrastructure-level events.
 *   - onStart subscribes to eventBus and translates to UI AgentEvent stream
 *     via the onEvent callback (CLI, WebSocket, NDJSON trace).
 *   - onStart/onStop emit agent:start / agent:end directly to onEvent
 *     (lifecycle events don't go through the bus — they are one-per-run).
 *
 * Design:
 *   - order = 5 (runs before all other middlewares so events fire first)
 *   - failPolicy = 'fail-open' (observability NEVER breaks execution)
 *
 * File tracking (via run.meta):
 *   - 'files' namespace, keys: 'read', 'modified', 'created'
 *   - Populated by afterToolExec based on tool name + input
 *   - SDKAgentRunner reads these at the end to build TaskResult
 */

import type {
  RunContext,
  LLMCtx,
  LLMCallResult,
  ToolExecCtx,
  ToolOutput,
  ContextMeta,
} from '../../../sdk/index.js';
import type {
  AgentEvent,
  AgentEventCallback,
  AgentStartEvent,
  AgentEndEvent,
  LLMStartEvent,
  IterationStartEvent,
  IterationEndEvent,
} from '../../../contracts/index.js';

// ── File-tracking tool name → operation mapping ────────────────────────────

const FILE_READ_TOOLS = new Set(['fs_read', 'fs_list']);
const FILE_WRITE_TOOLS = new Set(['fs_write', 'fs_patch']);
const FILE_CREATE_TOOLS = new Set(['fs_write']); // fs_write creates if not exists

// ── Helpers ────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function makeBase(
  type: AgentEvent['type'],
  agentId: string,
  parentAgentId: string | undefined,
  sessionId: string | undefined,
) {
  return { type, timestamp: now(), agentId, parentAgentId, sessionId };
}

function addToMeta(meta: ContextMeta, key: 'read' | 'modified' | 'created', filePath: string): void {
  const existing = meta.get<string[]>('files', key) ?? [];
  if (!existing.includes(filePath)) {
    meta.set('files', key, [...existing, filePath]);
  }
}

function trackFilesInMeta(ctx: ToolExecCtx, result: ToolOutput): void {
  if (!result.success) {return;}

  const meta = ctx.run.meta;
  const toolName = ctx.toolName;
  const input = ctx.input;

  // Extract file path from common input shapes
  const filePath =
    typeof input['path'] === 'string' ? input['path'] :
    typeof input['file_path'] === 'string' ? input['file_path'] :
    typeof input['filePath'] === 'string' ? input['filePath'] :
    null;

  if (!filePath) {return;}

  if (FILE_READ_TOOLS.has(toolName)) {
    addToMeta(meta, 'read', filePath);
  }

  if (FILE_WRITE_TOOLS.has(toolName)) {
    const outputLower = result.output.toLowerCase();
    if (FILE_CREATE_TOOLS.has(toolName) && outputLower.includes('created')) {
      addToMeta(meta, 'created', filePath);
    } else {
      addToMeta(meta, 'modified', filePath);
    }
  }
}

// ── ObservabilityMiddleware ────────────────────────────────────────────────

export class ObservabilityMiddleware {
  readonly name = 'observability';
  readonly order = 5;
  readonly config = { failPolicy: 'fail-open' as const };

  private _startedAt = 0;
  private _llmStartedAt = 0;
  private _toolStartedAt = new Map<string, number>();
  private _lastIteration = 0;
  private _totalTokens = 0;
  private _pendingDebug: { systemPrompt: string; messages: ReadonlyArray<{ role: string; content: unknown }> } | null = null;

  /** Extra metadata injected before onStart — set by runner after workspace discovery. */
  startMeta?: {
    budget?: { maxTokens: number; softLimitRatio: number; hardLimitRatio: number };
    workspaceTopology?: string[];
    workingDir?: string;
  };

  constructor(
    private readonly agentId: string,
    private readonly parentAgentId: string | undefined,
    private readonly sessionId: string | undefined,
    private readonly onEvent: AgentEventCallback | undefined,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────

  onStart(ctx: RunContext): void {
    this._startedAt = Date.now();

    // Subscribe to bus — translate infrastructure events to UI AgentEvent stream
    ctx.eventBus.on('llm:end', (d) => {
      this._totalTokens += d.promptTokens + d.completionTokens;
      this._emit({
        ...makeBase('llm:end', this.agentId, this.parentAgentId, this.sessionId),
        data: {
          tokensUsed: d.promptTokens + d.completionTokens,
          promptTokens: d.promptTokens,
          completionTokens: d.completionTokens,
          durationMs: d.durationMs,
          hasToolCalls: d.hasToolCalls,
          toolCallCount: d.toolCallCount ?? 0,
          stopReason: d.stopReason,
          content: typeof d.content === 'string' ? d.content.slice(0, 500) : undefined,
        },
      } as AgentEvent);
    });

    ctx.eventBus.on('tool:end', (d) => {
      this._emit({
        ...makeBase('tool:end', this.agentId, this.parentAgentId, this.sessionId),
        data: {
          toolName: d.toolName,
          success: d.success,
          durationMs: d.durationMs,
          outputLength: d.outputLength,
          output: d.output,
          metadata: d.metadata,
        },
      } as AgentEvent);
    });

    ctx.eventBus.on('middleware:event', (d) => {
      this._emit({
        ...makeBase('middleware:decision' as AgentEvent['type'], this.agentId, this.parentAgentId, this.sessionId),
        data: {
          middleware: d.name,
          decision: d.event,
          details: d.data,
        },
      } as AgentEvent);
    });

    ctx.eventBus.on('llm:debug', (d) => {
      this._emit({
        ...makeBase('llm:debug' as AgentEvent['type'], this.agentId, this.parentAgentId, this.sessionId),
        data: d,
      } as AgentEvent);
    });

    // agent:start goes directly to onEvent (lifecycle — not via bus)
    const event: AgentStartEvent = {
      ...makeBase('agent:start', this.agentId, this.parentAgentId, this.sessionId),
      data: {
        task: (ctx as unknown as { task?: string }).task ?? '',
        tier: ctx.tier,
        maxIterations: ctx.maxIterations,
        toolCount: ctx.tools.length,
        budget: this.startMeta?.budget,
        workspaceTopology: this.startMeta?.workspaceTopology,
        workingDir: this.startMeta?.workingDir,
      },
    } as AgentStartEvent;
    this._emit(event);
  }

  onStop(ctx: RunContext, reason: string): void {
    const filesCreated = ctx.meta.get<string[]>('files', 'created') ?? [];
    const filesModified = ctx.meta.get<string[]>('files', 'modified') ?? [];
    const finalAnswer = ctx.meta.get<string>('agent', 'finalAnswer') ?? '';
    const success = reason === 'report_complete' || reason === 'no_tool_calls';
    const event: AgentEndEvent = {
      ...makeBase('agent:end', this.agentId, this.parentAgentId, this.sessionId),
      data: {
        success,
        summary: finalAnswer,
        iterations: this._lastIteration,
        tokensUsed: this._totalTokens,
        durationMs: Date.now() - this._startedAt,
        filesCreated,
        filesModified,
        stopReason: reason,
      },
    } as AgentEndEvent;
    this._emit(event);
  }

  // ── Iteration hooks ────────────────────────────────────────────────────

  beforeIteration(ctx: RunContext): 'continue' {
    const event: IterationStartEvent = {
      ...makeBase('iteration:start', this.agentId, this.parentAgentId, this.sessionId),
      data: {
        iteration: ctx.iteration,
        maxIterations: ctx.maxIterations,
      },
    } as IterationStartEvent;
    this._emit(event);
    return 'continue';
  }

  afterIteration(ctx: RunContext): void {
    this._lastIteration = ctx.iteration;
    const event: IterationEndEvent = {
      ...makeBase('iteration:end', this.agentId, this.parentAgentId, this.sessionId),
      data: {
        iteration: ctx.iteration,
        hadToolCalls: false,
        toolCallCount: 0,
        cumulativeTokens: this._totalTokens,
      },
    } as IterationEndEvent;
    this._emit(event);
  }

  // ── LLM hooks — emit to bus; also emit llm:start directly for CLI ──────

  beforeLLMCall(ctx: LLMCtx): undefined {
    this._llmStartedAt = Date.now();
    const sysMsg = ctx.messages.find(m => m.role === 'system');
    const systemPromptChars = typeof sysMsg?.content === 'string' ? sysMsg.content.length : 0;

    ctx.run.eventBus.emit('llm:start', {
      iteration: ctx.run.iteration,
      messageCount: ctx.messages.length,
      toolCount: ctx.tools.length,
      systemPromptChars,
    });

    // Always capture for tracing — emitted to eventBus unconditionally
    this._pendingDebug = {
      systemPrompt: typeof sysMsg?.content === 'string' ? sysMsg.content : '',
      messages: ctx.messages,
    };

    // Also emit llm:start directly to onEvent for CLI spinner
    const event: LLMStartEvent = {
      ...makeBase('llm:start', this.agentId, this.parentAgentId, this.sessionId),
      data: {
        tier: ctx.run.tier,
        iteration: ctx.run.iteration,
        messageCount: ctx.messages.length,
        toolCount: ctx.tools.length,
        systemPromptChars,
      },
    } as LLMStartEvent;
    this._emit(event);

    return undefined;
  }

  afterLLMCall(ctx: LLMCtx, result: LLMCallResult): void {
    const durationMs = Date.now() - this._llmStartedAt;
    ctx.run.eventBus.emit('llm:end', {
      iteration: ctx.run.iteration,
      promptTokens: result.usage?.promptTokens ?? 0,
      completionTokens: result.usage?.completionTokens ?? 0,
      stopReason: result.stopReason ?? 'unknown',
      hasToolCalls: (result.toolCalls?.length ?? 0) > 0,
      toolCallCount: result.toolCalls?.length ?? 0,
      durationMs,
      content: result.content,
    });

    if (this._pendingDebug) {
      // Always emit to eventBus (persisted to NDJSON trace)
      ctx.run.eventBus.emit('llm:debug', {
        iteration: ctx.run.iteration,
        systemPrompt: this._pendingDebug.systemPrompt,
        messages: this._pendingDebug.messages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
        responseContent: result.content,
      });
      this._pendingDebug = null;
    }
  }

  // ── Tool hooks — emit to bus; also emit tool:start directly for CLI ────

  beforeToolExec(ctx: ToolExecCtx): 'execute' {
    this._toolStartedAt.set(ctx.toolName, Date.now());

    ctx.run.eventBus.emit('tool:start', {
      iteration: ctx.run.iteration,
      toolName: ctx.toolName,
      input: ctx.input,
    });

    // Also emit tool:start directly to onEvent for CLI rendering
    this._emit({
      ...makeBase('tool:start', this.agentId, this.parentAgentId, this.sessionId),
      data: {
        toolName: ctx.toolName,
        input: ctx.input,
      },
    } as AgentEvent);

    return 'execute';
  }

  afterToolExec(ctx: ToolExecCtx, result: ToolOutput): void {
    // Track file operations in meta
    trackFilesInMeta(ctx, result);

    const durationMs = Date.now() - (this._toolStartedAt.get(ctx.toolName) ?? Date.now());
    this._toolStartedAt.delete(ctx.toolName);

    ctx.run.eventBus.emit('tool:end', {
      iteration: ctx.run.iteration,
      toolName: ctx.toolName,
      success: result.success,
      durationMs,
      outputLength: result.output.length,
      output: result.output,
      metadata: result.metadata as Record<string, unknown> | undefined,
    });
    // tool:end UI event is delivered via bus subscription in onStart
  }

  // ── Private ────────────────────────────────────────────────────────────

  private _emit(event: AgentEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // fail-open: swallow errors from event callback
    }
  }
}
