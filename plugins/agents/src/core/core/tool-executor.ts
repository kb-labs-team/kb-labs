/**
 * ToolExecutor — normalizers + guards + output processors pipeline around ToolManager.
 *
 * Execution order per tool call:
 *   1. Build ToolExecCtx
 *   2. normalize()       — each InputNormalizer in order; transforms input
 *   3. validateInput()   — each guard in order; 'reject' → error output, stop chain
 *   4. toolManager.execute(name, input)
 *   5. validateOutput()  — each guard in order; 'sanitize' → replace output
 *   6. process()         — each output processor in order
 *   7. Return ToolOutput
 */

import type { ToolCallInput, ToolOutput, ToolExecCtx, ToolGuard, OutputProcessor, InputNormalizer, RunContext } from '../../sdk/index.js';
import type { ToolManager } from '../tools/tool-manager.js';

export class ToolExecutor {
  constructor(
    private readonly toolManager: ToolManager,
    private readonly guards: ReadonlyArray<ToolGuard>,
    private readonly processors: ReadonlyArray<OutputProcessor>,
    private readonly normalizers: ReadonlyArray<InputNormalizer> = [],
  ) {}

  getToolManager(): ToolManager {
    return this.toolManager;
  }

  async execute(calls: ToolCallInput[], run: RunContext): Promise<ToolOutput[]> {
    return Promise.all(calls.map((call) => this.executeSingle(call, run)));
  }

  private async executeSingle(call: ToolCallInput, run: RunContext): Promise<ToolOutput> {
    let input = call.input;

    // ── 0. Input normalization ─────────────────────────────────────────────────
    const ctx: ToolExecCtx = {
      run,
      toolName: call.name,
      input,
      iteration: run.iteration,
      abortSignal: run.abortSignal,
      requestId: run.requestId,
    };

    for (const normalizer of this.normalizers) {
      try {
        input = await normalizer.normalize(call.name, input, ctx);
        // Keep ctx.input in sync so downstream normalizers see latest
        (ctx as { input: Record<string, unknown> }).input = input;
      } catch {
        // Normalizers should never throw, but if they do — skip and continue
      }
    }

    // ── 1. Input validation ───────────────────────────────────────────────────
    for (const guard of this.guards) {
      if (!guard.validateInput) {continue;}
      const result = await guard.validateInput(call.name, input, ctx);
      if (!result.ok && result.action === 'reject') {
        return {
          toolCallId: call.id,
          output: `[guard:${guard.name}] Input rejected: ${result.reason}`,
          success: false,
          error: result.reason,
        };
      }
    }

    // ── 2. Execute tool ───────────────────────────────────────────────────────
    let rawOutput: string;
    let success: boolean;
    let error: string | undefined;
    let metadata: Record<string, unknown> | undefined;

    try {
      const toolResult = await this.toolManager.execute(call.name, input);
      success = toolResult.success;
      rawOutput = toolResult.output ?? toolResult.error ?? '';
      error = toolResult.error;
      metadata = toolResult.metadata;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        toolCallId: call.id,
        output: `Tool execution error: ${msg}`,
        success: false,
        error: msg,
      };
    }

    // ── 3. Output validation ──────────────────────────────────────────────────
    for (const guard of this.guards) {
      if (!guard.validateOutput) {continue;}
      const result = await guard.validateOutput(call.name, rawOutput, ctx);
      if (!result.ok) {
        if (result.action === 'sanitize') {
          rawOutput = result.sanitized;
        } else if (result.action === 'reject') {
          return {
            toolCallId: call.id,
            output: `[guard:${guard.name}] Output rejected: ${result.reason}`,
            success: false,
            error: result.reason,
          };
        }
      }
    }

    // ── 4. Output processing ──────────────────────────────────────────────────
    for (const processor of this.processors) {
      rawOutput = await processor.process(rawOutput, ctx);
    }

    return {
      toolCallId: call.id,
      output: rawOutput,
      success,
      error,
      metadata,
    };
  }
}
