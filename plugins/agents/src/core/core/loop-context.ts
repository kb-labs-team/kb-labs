/**
 * LoopContextImpl — implements LoopContext from @kb-labs/agents/sdk.
 *
 * Provides the infrastructure primitives that LinearExecutionLoop calls:
 *   - appendMessage()   — the only way to mutate message history
 *   - callLLM()         — LLM call with beforeLLMCall/afterLLMCall middleware
 *   - executeTools()    — tool execution with beforeToolExec/afterToolExec middleware
 *
 * All business logic lives in the ExecutionLoop (LinearExecutionLoop).
 * LoopContextImpl is intentionally stateless between calls.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IterationSnapshot, RunEvaluation } from '../../contracts/index.js';
import type { LLMMessage } from '@kb-labs/sdk';
import type {
  LoopContext,
  LLMCallResult,
  ToolCallInput,
  ToolOutput,
  RunContext,
  LLMCtx,
  ToolExecCtx,
  ControlAction,
} from '../../sdk/index.js';
import type { ILLM } from '@kb-labs/sdk';
import type { MiddlewarePipeline } from '../middleware/pipeline.js';
import type { ToolExecutor } from './tool-executor.js';

export class LoopContextImpl implements LoopContext {
  readonly run: RunContext;

  constructor(
    run: RunContext,
    private readonly messages: LLMMessage[],   // mutable backing array
    private readonly llm: ILLM,
    private readonly pipeline: MiddlewarePipeline,
    private readonly executor: ToolExecutor,
    private readonly onTokensConsumed: (delta: number) => void,
    private readonly runEvaluator: (run: RunContext, snapshot: IterationSnapshot) => Promise<RunEvaluation | null>,
  ) {
    this.run = run;
  }

  // ── LoopContext API ────────────────────────────────────────────────────────

  appendMessage(message: LLMMessage): void {
    this.messages.push(message);
  }

  async beforeIteration(): Promise<ControlAction> {
    return this.pipeline.beforeIteration(this.run);
  }

  async afterIteration(): Promise<void> {
    await this.pipeline.afterIteration(this.run);
  }

  async callLLM(): Promise<LLMCallResult> {
    const llmCtx: LLMCtx = {
      run: this.run,
      messages: [...this.messages],
      tools: this.run.tools,
    };

    // Apply beforeLLMCall middleware patch
    const patch = await this.pipeline.beforeLLMCall(llmCtx);

    const messages = patch.messages ?? llmCtx.messages;
    const tools = patch.tools ?? llmCtx.tools;
    const temperature = patch.temperature;
    const toolChoice = patch.toolChoice;

    // Call LLM
    let rawResponse: Awaited<ReturnType<NonNullable<ILLM['chatWithTools']>>>;
    try {
      rawResponse = await this.llm.chatWithTools!(messages, {
        tools,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(toolChoice !== undefined ? { toolChoice } : {}),
      });
    } catch (err) {
      throw err;
    }

    // Convert to LLMCallResult (SDK shape)
    const result: LLMCallResult = {
      content: rawResponse.content,
      toolCalls: (rawResponse.toolCalls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: tc.input as Record<string, unknown>,
      })),
      usage: rawResponse.usage
        ? {
            promptTokens: rawResponse.usage.promptTokens,
            completionTokens: rawResponse.usage.completionTokens,
          }
        : undefined,
      // stopReason: top-level field (if adapter exposes it) OR from providerUsage
      stopReason:
        (rawResponse as { stopReason?: string }).stopReason ??
        (rawResponse.usage?.providerUsage as { stopReason?: string } | undefined)?.stopReason,
    };

    // Notify token tracking
    if (result.usage) {
      this.onTokensConsumed(result.usage.promptTokens + result.usage.completionTokens);
    }

    // Append assistant message to history
    const assistantMessage: LLMMessage = {
      role: 'assistant',
      content: rawResponse.content,
      toolCalls: rawResponse.toolCalls,
    };
    this.messages.push(assistantMessage);

    // Run afterLLMCall middleware
    await this.pipeline.afterLLMCall(llmCtx, result);

    return result;
  }

  async executeTools(calls: ToolCallInput[]): Promise<ToolOutput[]> {
    // Partition into concurrent-safe and sequential groups.
    // Concurrent-safe tools run in parallel via Promise.all,
    // sequential tools run one-by-one after them.
    // Results are emitted in original call order regardless of execution order.
    const concurrentCalls: ToolCallInput[] = [];
    const sequentialCalls: ToolCallInput[] = [];

    for (const call of calls) {
      const resolved = this.executor.getToolManager().getTool(call.name);
      if (resolved?.concurrencySafe && calls.length > 1) {
        concurrentCalls.push(call);
      } else {
        sequentialCalls.push(call);
      }
    }

    // Map to collect results by toolCallId for ordered emission
    const outputMap = new Map<string, ToolOutput>();

    // Execute concurrent-safe tools in parallel
    if (concurrentCalls.length > 0) {
      const concurrentResults = await Promise.all(
        concurrentCalls.map(call => this._executeSingleTool(call)),
      );
      for (const output of concurrentResults) {
        outputMap.set(output.toolCallId, output);
      }
    }

    // Execute sequential tools one-by-one
    for (const call of sequentialCalls) {
      const output = await this._executeSingleTool(call);
      outputMap.set(output.toolCallId, output);
    }

    // Emit results in original call order
    const outputs: ToolOutput[] = [];
    for (const call of calls) {
      const output = outputMap.get(call.id);
      if (output) {outputs.push(output);}
    }

    // Append tool result messages to history.
    // Large outputs are persisted to disk — LLM sees a preview + file path.
    for (const out of outputs) {
      this.messages.push({
        role: 'tool',
        content: this._maybePersistOutput(out),
        toolCallId: out.toolCallId,
      });
    }

    return outputs;
  }

  /** Execute a single tool call with middleware hooks. */
  private async _executeSingleTool(call: ToolCallInput): Promise<ToolOutput> {
    const toolCtx: ToolExecCtx = {
      run: this.run,
      toolName: call.name,
      input: call.input,
      iteration: this.run.iteration,
      abortSignal: this.run.abortSignal,
      requestId: this.run.requestId,
    };

    // Check if middleware wants to skip this tool call
    const decision = await this.pipeline.beforeToolExec(toolCtx);
    if (decision === 'skip') {
      return {
        toolCallId: call.id,
        output: '[skipped by middleware]',
        success: true,
      };
    }

    // Execute through ToolExecutor (guards + processors)
    const results = await this.executor.execute([call], this.run);
    const output = results[0] ?? {
      toolCallId: call.id,
      output: 'Tool execution returned no result',
      success: false,
    };

    // Run afterToolExec middleware
    await this.pipeline.afterToolExec(toolCtx, output);

    return output;
  }

  // ── Tool output persistence ──────────────────────────────────────────────
  // Large tool outputs are saved to disk. LLM sees a preview + file path.
  // Inspired by Claude Code maxResultSizeChars + disk persistence.

  private static readonly OUTPUT_PERSIST_THRESHOLD = 30_000; // chars — only very large outputs
  private static readonly OUTPUT_PREVIEW_LENGTH = 8_000; // chars shown to LLM
  /**
   * Tools whose output is NEVER persisted to disk — agent needs full content.
   * Inspired by Claude Code: Read tool has maxResultSizeChars=Infinity.
   * Size control for these tools happens at tool level (trimOutput, maxOutputChars),
   * not at loop level.
   */
  private static readonly PERSIST_EXEMPT_TOOLS = new Set([
    'fs_read', 'fs_list', 'fs_write', 'fs_patch', 'fs_replace',
    'plan_write', 'plan_validate', 'report',
    'memory_get', 'archive_recall',
    'todo_create', 'todo_update', 'todo_get',
  ]);

  /**
   * If output exceeds threshold, persist to disk and return preview + path.
   * Otherwise return output as-is.
   */
  private _maybePersistOutput(out: ToolOutput): string {
    const output = out.output;
    if (!output || output.length <= LoopContextImpl.OUTPUT_PERSIST_THRESHOLD) {
      return output;
    }

    // Some tools need full output in context — never persist them
    const toolName = (out as { toolName?: string }).toolName
      ?? out.toolCallId?.split('_')[0]
      ?? '';
    if (LoopContextImpl.PERSIST_EXEMPT_TOOLS.has(toolName)) {
      return output;
    }

    // Persist to session directory
    const sessionId = this.run.meta.get<string>('session', 'id') ?? this.run.requestId;
    const workingDir = this.run.meta.get<string>('session', 'workingDir') ?? process.cwd();
    const outputDir = path.join(workingDir, '.kb', 'agents', 'sessions', sessionId, 'tool-outputs');

    try {
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const filename = `${out.toolCallId || Date.now()}.txt`;
      const filePath = path.join(outputDir, filename);
      fs.writeFileSync(filePath, output, 'utf-8');

      const preview = output.slice(0, LoopContextImpl.OUTPUT_PREVIEW_LENGTH);
      const remaining = output.length - LoopContextImpl.OUTPUT_PREVIEW_LENGTH;

      return `${preview}\n\n[OUTPUT PERSISTED: ${remaining} more chars saved to ${filePath} — use fs_read if you need the full content]`;
    } catch {
      // Fallback: truncate without persisting (never break execution)
      return output.slice(0, LoopContextImpl.OUTPUT_PERSIST_THRESHOLD) +
        `\n\n[TRUNCATED: ${output.length - LoopContextImpl.OUTPUT_PERSIST_THRESHOLD} more chars not shown]`;
    }
  }

  async evaluateRun(snapshot: IterationSnapshot): Promise<RunEvaluation | null> {
    return this.runEvaluator(this.run, snapshot);
  }
}
