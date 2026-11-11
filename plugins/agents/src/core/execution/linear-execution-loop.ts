/**
 * LinearExecutionLoop — SDK-native implementation of ExecutionLoop.
 *
 * Implements the agent-sdk ExecutionLoop interface:
 *   run(ctx: LoopContext): Promise<LoopResult>
 *
 * LoopContext (from agent-sdk) provides only infrastructure primitives:
 *   - run: RunContext          — shared run state
 *   - appendMessage()         — only way to mutate message history
 *   - callLLM()               — LLM call with middleware pipeline applied
 *   - executeTools()          — tool execution with guards + processors applied
 *
 * All business logic (stop detection, report extraction, loop detection)
 * lives here — not in LoopContext. This keeps the contract minimal.
 *
 * Stop priority order (lower number = higher priority):
 *   0  ABORT        — abortSignal fired
 *   1  REPORT       — agent called the report tool
 *   2  HARD_BUDGET  — token hard limit (via BudgetMiddleware metadata)
 *   3  MAX_ITER     — hit maxIterations
 *   4  LOOP         — same 3 tool calls repeated twice
 *   5  NO_TOOLS     — LLM returned no tool calls (natural completion)
 *
 * Returns LoopOutput — AgentRunner builds the full TaskResult from it.
 */

import type { IterationSnapshot } from '../../contracts/index.js';
import type { ExecutionLoop, LoopContext, LoopResult, LoopOutput, LLMCallResult, ToolCallInput } from '../../sdk/index.js';

// ─── Canonical JSON serialization ────────────────────────────────────────────
// JSON.stringify has non-deterministic key order across JS engines.
// canonicalJson sorts object keys recursively for stable loop-detection signatures.

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {return JSON.stringify(value);}
  if (Array.isArray(value)) {return '[' + value.map(canonicalJson).join(',') + ']';}
  const keys = Object.keys(value as object).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k])).join(',') + '}';
}

// ─── Internal stop priorities ─────────────────────────────────────────────────

const PRIORITY = {
  ABORT: 0,
  REPORT: 1,
  HARD_BUDGET: 2,
  MAX_ITER: 3,
  LOOP: 4,
  NO_TOOLS: 5,
} as const;

interface StopResult {
  priority: number;
  reasonCode: string;
  reason: string;
  answer?: string;
  metadata?: Record<string, unknown>;
}

// ─── Loop detection helper ────────────────────────────────────────────────────

class LoopDetector {
  private readonly history: string[] = [];
  private readonly windowSize: number;

  constructor(windowSize = 6) {
    this.windowSize = windowSize;
  }

  /** Record tool calls and return true if a repeat pattern is detected. */
  check(calls: ToolCallInput[]): boolean {
    // Normalize pagination params so that repeated scans with different offsets are detected
    const sig = calls.map(c => {
      const normalized = { ...c.input as Record<string, unknown> };
      delete normalized['offset'];
      delete normalized['limit'];
      return `${c.name}:${canonicalJson(normalized)}`;
    }).join('|');
    this.history.push(sig);
    if (this.history.length > this.windowSize) {
      this.history.shift();
    }

    if (this.history.length < this.windowSize) {return false;}

    const half = this.windowSize / 2;
    const last = this.history.slice(-half).join('>>>');
    const prev = this.history.slice(-this.windowSize, -half).join('>>>');
    return last === prev;
  }
}

// ─── LinearExecutionLoop ──────────────────────────────────────────────────────

export class LinearExecutionLoop implements ExecutionLoop {
  async run(ctx: LoopContext): Promise<LoopResult> {
    const { run } = ctx;
    const loopDetector = new LoopDetector();
    let totalTokens = 0;

    for (let i = 0; i < run.maxIterations; i++) {
      run.iteration = i + 1;

      // ── Abort check ──────────────────────────────────────────────────────────
      if (run.abortSignal.aborted || run.aborted) {
        return complete({
          priority: PRIORITY.ABORT,
          reasonCode: 'abort_signal',
          reason: 'Execution aborted',
        });
      }

      // ── Middleware beforeIteration ──────────────────────────────────────────
      const action = await ctx.beforeIteration();
      if (action === 'stop') {
        return complete({
          priority: PRIORITY.HARD_BUDGET,
          reasonCode: 'middleware_stop',
          reason: 'Middleware requested stop',
        });
      }
      if (action === 'escalate') {
        return { outcome: 'escalate', reason: 'Middleware requested tier escalation' };
      }

      // ── Hard budget (set by BudgetMiddleware via meta) ───────────────────────
      if (run.meta.get<boolean>('budget', 'exhausted')) {
        return complete({
          priority: PRIORITY.HARD_BUDGET,
          reasonCode: 'hard_budget',
          reason: run.meta.get<string>('budget', 'exhaustedReason') ?? 'Token budget exhausted',
        });
      }

      // ── LLM call ──────────────────────────────────────────────────────────────
      let response: LLMCallResult;
      try {
        response = await ctx.callLLM();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return failure(`LLM call failed: ${msg}`);
      }

      // Track tokens (BudgetMiddleware reads RunContext.meta independently)
      if (response.usage) {
        totalTokens += response.usage.promptTokens + response.usage.completionTokens;
        run.meta.set('loop', 'totalTokens', totalTokens);
      }

      const toolCalls = response.toolCalls ?? [];

      // ── Report tool (priority 1 — always wins post-LLM) ─────────────────────
      const reportStop = extractReport(response);
      if (reportStop) {
        // Execute the report tool through middleware so tool:start/tool:end events
        // are emitted — plan-mode-handler and session tracing depend on them.
        const reportCall = response.toolCalls?.find(tc => tc.name === 'report');
        if (reportCall) {
          const reportInput: ToolCallInput = {
            id: reportCall.id,
            name: reportCall.name,
            input: reportCall.input,
          };
          let reportBlocked = false;
          let reportMetadata: Record<string, unknown> | undefined;
          try {
            const toolResults = await ctx.executeTools([reportInput]);
            // If report tool returned success=false (e.g. plan_validate gate),
            // do NOT complete — let the agent see the error and continue.
            const reportResult = toolResults?.find(r => r.toolCallId === reportCall.id);
            if (reportResult && reportResult.success === false) {
              reportBlocked = true;
            }
            reportMetadata = reportResult?.metadata;
          } catch {
            // fail-open: report tool execution error should not prevent completion
          }
          if (reportBlocked) {
            await ctx.afterIteration();
            continue;
          }
          await ctx.afterIteration();
          return complete({
            ...reportStop,
            metadata: reportMetadata,
          });
        }
        await ctx.afterIteration();
        return complete(reportStop);
      }

      // ── No tool calls → force report if there's content ─────────────────────
      if (toolCalls.length === 0) {
        if (response.content && response.content.trim().length > 0) {
          // LLM responded with text instead of calling report.
          // Nudge it once with tool_choice=required forcing a report call.
          let nudgedResponse: LLMCallResult | null = null;
          try {
            // Inject a reminder message and re-call with forced tool choice
            ctx.appendMessage({
              role: 'system',
              content: 'You must call the `report` tool with your answer. Do NOT respond with plain text.',
            });
            nudgedResponse = await ctx.callLLM();
          } catch {
            // fail-open: nudge failed, fall through to no_tool_calls
          }

          if (nudgedResponse) {
            const nudgedReport = extractReport(nudgedResponse);
            if (nudgedReport) {
              const reportCall = nudgedResponse.toolCalls?.find(tc => tc.name === 'report');
              if (reportCall) {
                let reportBlocked = false;
                let reportMetadata: Record<string, unknown> | undefined;
                try {
                  const toolResults = await ctx.executeTools([{ id: reportCall.id, name: reportCall.name, input: reportCall.input }]);
                  const reportResult = toolResults?.find(r => r.toolCallId === reportCall.id);
                  if (reportResult && reportResult.success === false) {
                    reportBlocked = true;
                  }
                  reportMetadata = reportResult?.metadata;
                } catch { /* fail-open */ }
                if (reportBlocked) {
                  await ctx.afterIteration();
                  continue;
                }
                await ctx.afterIteration();
                return complete({
                  ...nudgedReport,
                  metadata: reportMetadata,
                });
              }
              await ctx.afterIteration();
              return complete(nudgedReport);
            }
            // Nudge didn't produce report either — fall through with nudged content or original
            await ctx.afterIteration();
            return complete({
              priority: PRIORITY.NO_TOOLS,
              reasonCode: 'no_tool_calls',
              reason: 'LLM produced no tool calls after nudge',
              answer: nudgedResponse.content || response.content,
            });
          }
        }

        await ctx.afterIteration();
        return complete({
          priority: PRIORITY.NO_TOOLS,
          reasonCode: 'no_tool_calls',
          reason: 'LLM produced no tool calls',
          answer: response.content,
        });
      }

      // ── Tool execution ────────────────────────────────────────────────────────
      const inputs: ToolCallInput[] = toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
      }));

      try {
        await ctx.executeTools(inputs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.afterIteration();
        return failure(`Tool execution failed: ${msg}`);
      }

      // Build compact per-iteration recap so the next LLM call does not "forget"
      // what already happened in this run.
      const reads = run.meta.get<string[]>('files', 'read') ?? [];
      const modified = run.meta.get<string[]>('files', 'modified') ?? [];
      const created = run.meta.get<string[]>('files', 'created') ?? [];
      const evidenceCount = reads.length + modified.length + created.length;
      const prevEvidenceCount = run.meta.get<number>('loop', 'lastEvidenceCount') ?? 0;

      const newEvidence = evidenceCount > prevEvidenceCount;

      // Keep offset in signature: chunk-reads of a large file (same path, different offsets)
      // must be treated as distinct calls, not repeats. Only strip limit (size hint, not identity).
      const toolSignature = inputs.map((t) => {
        const normalized = { ...t.input as Record<string, unknown> };
        delete normalized['limit'];
        return `${t.name}:${canonicalJson(normalized)}`;
      }).join('|');
      const lastToolSignature = run.meta.get<string>('loop', 'lastToolSignature') ?? '';
      let repeatsWithoutEvidence = run.meta.get<number>('loop', 'repeatsWithoutEvidence') ?? 0;
      let repeatNoEvidenceCount = run.meta.get<number>('loop', 'repeatNoEvidenceCount') ?? 0;
      if (!newEvidence && toolSignature === lastToolSignature) {
        repeatsWithoutEvidence += 1;
        repeatNoEvidenceCount += 1;
      } else {
        repeatsWithoutEvidence = 0;
      }

      run.meta.set('loop', 'lastEvidenceCount', evidenceCount);
      run.meta.set('loop', 'lastToolSignature', toolSignature);
      run.meta.set('loop', 'repeatsWithoutEvidence', repeatsWithoutEvidence);
      run.meta.set('loop', 'repeatNoEvidenceCount', repeatNoEvidenceCount);
      run.meta.set(
        'loop',
        'lastIterationSummary',
        `Iteration ${run.iteration}: tools=${inputs.map((t) => t.name).join(', ')}; ` +
          `evidence=${newEvidence ? 'new' : 'none'}; files(read=${reads.length}, modified=${modified.length}, created=${created.length})`,
      );

      const snapshot: IterationSnapshot = {
        iteration: run.iteration,
        maxIterations: run.maxIterations,
        toolNames: inputs.map((t) => t.name),
        toolSignature,
        totalTokens,
        evidenceCount,
        evidenceDelta: Math.max(0, evidenceCount - prevEvidenceCount),
        filesReadCount: reads.length,
        filesModifiedCount: modified.length,
        filesCreatedCount: created.length,
        newEvidence,
        repeatsWithoutEvidence,
        repeatNoEvidenceCount,
        lastIterationSummary: run.meta.get<string>('loop', 'lastIterationSummary'),
      };
      const evaluation = await ctx.evaluateRun(snapshot);
      if (evaluation) {
        run.meta.set('evaluation', 'lastRecommendation', evaluation.recommendation);
        run.meta.set('evaluation', 'lastReadinessScore', evaluation.readinessScore);
        run.meta.set('evaluation', 'lastEvidenceGain', evaluation.evidenceGain);
        run.meta.set('evaluation', 'lastRationale', evaluation.rationale);
      }

      await ctx.afterIteration();

      if (evaluation?.recommendation === 'narrow') {
        const narrowNudgeSent = run.meta.get<boolean>('evaluation', 'narrowNudgeSent') ?? false;
        if (!narrowNudgeSent) {
          run.meta.set('evaluation', 'narrowNudgeSent', true);
          ctx.appendMessage({
            role: 'system',
            content:
              'Recent steps are not adding enough new evidence. Narrow the search to the most important unresolved gaps before continuing.',
          });
        }
      }

      if (evaluation?.recommendation === 'synthesize') {
        const synthesisNudgeSent = run.meta.get<boolean>('evaluation', 'synthesisNudgeSent') ?? false;
        if (!synthesisNudgeSent) {
          run.meta.set('evaluation', 'synthesisNudgeSent', true);
          ctx.appendMessage({
            role: 'system',
            content:
              'You now have enough evidence to produce the best bounded answer available. Prefer synthesizing from verified evidence instead of starting new exploration.',
          });
          continue;
        }
      }

      if (repeatsWithoutEvidence >= 2) {
        return complete({
          priority: PRIORITY.LOOP,
          reasonCode: 'repeated_without_progress',
          reason: 'Repeated tool intent without new evidence',
          answer: 'Agent is repeating similar actions without collecting new evidence. Returning partial result to avoid wasted iterations.',
        });
      }

      // ── Loop detection → complete with partial result (no forced escalation) ─
      if (loopDetector.check(inputs)) {
        return complete({
          priority: PRIORITY.LOOP,
          reasonCode: 'loop_detected',
          reason: 'Agent detected repeated tool-call pattern',
          answer: 'Agent detected a repeated tool-call loop. Returning partial result; refine scope or constraints to continue.',
        });
      }

      // ── Max iterations → complete with partial result (no forced escalation) ─
      if (i + 1 >= run.maxIterations) {
        return complete({
          priority: PRIORITY.MAX_ITER,
          reasonCode: 'max_iterations',
          reason: `Maximum iterations reached (${run.maxIterations})`,
          answer: `Maximum iterations reached (${run.maxIterations}). Returning partial result with collected evidence.`,
        });
      }
    }

    // maxIterations = 0 edge case
    return failure('No iterations executed (maxIterations = 0)');
  }
}

// ─── Module-level helpers (pure functions, no this) ──────────────────────────

function extractReport(response: LLMCallResult): StopResult | null {
  const reportCall = response.toolCalls?.find(tc => tc.name === 'report');
  if (!reportCall) {return null;}

  const answer =
    typeof reportCall.input?.['answer'] === 'string'
      ? reportCall.input['answer']
      : response.content;

  return {
    priority: PRIORITY.REPORT,
    reasonCode: 'report_complete',
    reason: 'Agent called report tool',
    answer,
  };
}

function complete(stop: StopResult): LoopResult {
  const successfulStops = new Set(['report_complete', 'no_tool_calls']);
  const result: LoopOutput = {
    answer: stop.answer ?? stop.reason,
    reasonCode: stop.reasonCode,
    success: successfulStops.has(stop.reasonCode),
    metadata: { stopPriority: stop.priority, ...(stop.metadata ?? {}) },
  };
  return { outcome: 'complete', result };
}

function failure(reason: string): LoopResult {
  const result: LoopOutput = {
    answer: reason,
    reasonCode: 'error',
    success: false,
    metadata: { stopPriority: -1 },
  };
  return { outcome: 'complete', result };
}
