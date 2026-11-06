/**
 * agent:trace:diagnose - Quick diagnostic analysis of agent execution
 *
 * One command to answer "what went wrong?" — shows errors, context drops,
 * tool failures, loop detection, LLM reasoning, and quality indicators.
 *
 * Usage:
 *   pnpm kb agent trace doctor --task-id=<id>
 *   pnpm kb agent trace doctor --task-id=<id> --json
 */

import { defineCommand, type PluginCommandContextV3 , type CommandResult} from '@kb-labs/sdk';
import type { TraceCommandResponse, TraceErrorCode, DetailedTraceEntry } from '../../contracts/index.js';
import { loadTrace, formatTraceLoadError } from '../../tracing/index.js';
import { normalizeTraceEvents } from './trace-event-normalizer.js';

/** Shape of raw data in llm:end / llm:call events (legacy + new formats) */
interface LLMRawEvent {
  response?: { usage?: { inputTokens?: number; outputTokens?: number } };
  cost?: { totalCost?: number };
  content?: string;
  hasToolCalls?: boolean;
  tokensUsed?: number;
  durationMs?: number;
  iteration?: number;
}

/** Shape of raw data in tool:end / tool:execution events */
interface ToolRawEvent {
  tool?: { name?: string };
  output?: { success?: boolean; error?: { message?: string } };
  toolName?: string;
  durationMs?: number;
  timing?: { durationMs?: number };
  success?: boolean;
  input?: unknown;
  error?: string | { message?: string; stack?: string };
  iteration?: number;
}

/** Shape of raw data in error:captured / agent:error events */
interface ErrorRawEvent {
  error?: string | { message?: string; stack?: string };
  agentStack?: unknown;
  iteration?: number;
}

/** Raw data accessed on arbitrary events via data or raw fallback */
interface GenericRawData {
  toolName?: string;
  tool?: { name?: string };
  durationMs?: number;
  timing?: { durationMs?: number };
  success?: boolean;
  output?: { success?: boolean; error?: { message?: string } };
  input?: unknown;
  error?: string | { message?: string; stack?: string };
  iteration?: number;
  content?: string;
  hasToolCalls?: boolean;
}

type TraceDiagnoseInput = {
  taskId?: string;
  'task-id'?: string;
  json?: boolean;
};

interface DiagnosticReport {
  taskId: string;
  summary: {
    totalEvents: number;
    iterations: number;
    totalTokens: number;
    durationMs: number;
    success: boolean;
    confidence: number;
  };
  issues: DiagnosticIssue[];
  contextHealth: {
    maxContextChars: number;
    maxContextTokens: number;
    totalDroppedMessages: number;
    truncatedToolOutputs: number;
    contextGrowthHistory: Array<{
      iteration: number;
      messageCount: number;
      totalChars: number;
      droppedMessages: number;
    }>;
    tokenGrowth: Array<{
      iteration: number;
      cumulativeTokens: number;
    }>;
    systemPromptChanges: Array<{
      iteration: number;
      charsDelta: number;
    }>;
  };
  toolUsage: {
    totalCalls: number;
    failures: number;
    toolBreakdown: Record<string, { calls: number; failures: number; avgDurationMs: number }>;
    slowCalls: Array<{ tool: string; durationMs: number; iteration: number; args: string }>;
  };
  llmBehavior: {
    totalCalls: number;
    emptyResponses: number;
    reasoningTexts: Array<{
      iteration: number;
      preview: string;
    }>;
    stoppingReasons: string[];
  };
  loopDetection: {
    detected: boolean;
    repeatedPatterns: string[];
  };
}

interface DiagnosticIssue {
  severity: 'critical' | 'warning' | 'info';
  category: 'error' | 'context' | 'tool' | 'llm' | 'loop' | 'quality';
  message: string;
  iteration?: number;
  details?: string;
}

export default defineCommand({
  id: 'trace:diagnose',
  description: 'Quick diagnostic analysis — answers "what went wrong?" in one command',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: TraceDiagnoseInput): Promise<CommandResult> {
      const flags: TraceDiagnoseInput =
        (typeof input === 'object' && input !== null && 'flags' in input)
          ? (input as { flags: TraceDiagnoseInput }).flags
          : input;
      const taskId = (flags['task-id'] ?? flags.taskId) as string | undefined;

      try {
        const loaded = await loadTrace(taskId);
        if (!loaded.ok) {
          return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: formatTraceLoadError(loaded.error), hint: 'Check the task ID, then rerun `kb agents trace diagnose --task-id <id>`.' } };
        }
        const events = loaded.events;

        const report = analyzeDiagnostics(taskId ?? '', events);
        const criticalIssues = report.issues.filter((issue) => issue.severity === 'critical');
        const outcome: CommandResult = criticalIssues.length > 0
          ? { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: `${criticalIssues.length} critical trace issue(s) were found.`, hint: 'Review the diagnostic report, then rerun `kb agents trace diagnose --task-id <id>`.', diagnostics: criticalIssues.map((issue) => ({ code: 'KB_AGENT_TRACE_CRITICAL', severity: 'error', message: issue.message })) } }
          : report;
        if (flags.json) {
          return criticalIssues.length > 0 ? outcome : { success: true, report };
        }
        printReport(ctx, report);

        return outcome;
      } catch (err) {
        return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: err instanceof Error ? err.message : String(err), hint: 'Check the task ID and trace file, then rerun `kb agents trace diagnose --task-id <id>`.' } };
      }
    },
  },
});

function analyzeDiagnostics(taskId: string, events: DetailedTraceEntry[]): DiagnosticReport {
  const normalized = normalizeTraceEvents(events);
  const issues: DiagnosticIssue[] = [];

  // === Summary ===
  // Use normalized events (type: string, data: Record<string,unknown>) to avoid
  // union type narrowing on the raw DetailedTraceEntry discriminated union.
  const taskStart = normalized[0];
  const agentEnd = [...normalized].reverse().find(e => e.type === 'agent:end');
  const iterationStarts = normalized.filter(e => e.type === 'iteration:start');
  const iterations = iterationStarts.length || Math.max(0, ...normalized.map(e => e.iteration));
  const llmEndTokens = normalized
    .filter(e => e.type === 'llm:end')
    .reduce((sum, e) => sum + (Number(e.data.tokensUsed) || 0), 0);
  const totalTokens = Number(agentEnd?.data?.tokensUsed) || llmEndTokens;
  const lastNormalized = normalized[normalized.length - 1];
  const durationMs = Number(agentEnd?.data?.durationMs)
    || (taskStart && lastNormalized
      ? new Date(lastNormalized.raw.timestamp).getTime() - new Date(taskStart.raw.timestamp).getTime()
      : 0);
  const success = Boolean(agentEnd?.data?.success ?? true);

  // Confidence from report_to_orchestrator
  let confidence = 0;
  const toolResults = normalized.filter(e =>
    e.type === 'tool:end' || e.type === 'tool_result' || e.type === 'tool:execution'
  );
  for (const tr of toolResults) {
    const rawTool = tr.raw as ToolRawEvent;
    const data = tr.data || rawTool.output || tr.raw;
    const output = typeof (data as GenericRawData)?.output === 'string'
      ? (data as GenericRawData).output as string
      : JSON.stringify((data as GenericRawData)?.output || '');
    if (output.includes('"confidence"')) {
      try {
        const match = output.match(/"confidence"\s*:\s*([\d.]+)/);
        if (match?.[1]) {confidence = parseFloat(match[1]);}
      } catch { /* ignore */ }
    }
  }

  // === Context Health ===
  // Access all events through normalized (type: string, data: Record<string,unknown>)
  // to avoid TypeScript narrowing on the DetailedTraceEntry discriminated union.
  const contextSnapshots = normalized.filter(e => e.type === 'context:snapshot');
  const contextDiffs = normalized.filter(e => e.type === 'context:diff');
  const contextTrims = normalized.filter(e => e.type === 'context:trim');
  let maxContextChars = 0;
  let totalDroppedMessages = 0;
  let truncatedToolOutputs = 0;

  const contextGrowthHistory: DiagnosticReport['contextHealth']['contextGrowthHistory'] = [];

  for (const snap of contextSnapshots) {
    const chars = Number(snap.data.totalChars) || 0;
    const slidingWindow = snap.data.slidingWindow as { droppedMessages?: number } | undefined;
    const dropped = slidingWindow?.droppedMessages || 0;
    if (chars > maxContextChars) {maxContextChars = chars;}
    totalDroppedMessages += dropped;
    contextGrowthHistory.push({
      iteration: snap.iteration,
      messageCount: Number(snap.data.messageCount) || 0,
      totalChars: chars,
      droppedMessages: dropped,
    });
  }

  truncatedToolOutputs = contextTrims.length;

  // Token growth per iteration (from iteration:end cumulativeTokens)
  const tokenGrowth: Array<{ iteration: number; cumulativeTokens: number }> = [];
  let cumulative = 0;
  for (const e of normalized.filter(e => e.type === 'llm:end')) {
    cumulative += Number(e.data.tokensUsed) || 0;
    tokenGrowth.push({ iteration: e.iteration, cumulativeTokens: cumulative });
  }

  // System prompt changes (from context:diff)
  const systemPromptChanges: Array<{ iteration: number; charsDelta: number }> = [];
  for (const cd of contextDiffs) {
    const diff = cd.data.diff as { systemPromptChanged?: boolean; systemPromptCharsDelta?: number; droppedMessages?: number } | undefined;
    if (diff?.systemPromptChanged) {
      const delta = diff.systemPromptCharsDelta || 0;
      systemPromptChanges.push({
        iteration: cd.iteration,
        charsDelta: delta,
      });
      issues.push({
        severity: 'warning',
        category: 'context',
        message: `System prompt changed at iteration ${cd.iteration} (${delta > 0 ? '+' : ''}${delta} chars)`,
      });
    }
  }

  // Context issues
  if (totalDroppedMessages > 0) {
    issues.push({
      severity: 'warning',
      category: 'context',
      message: `${totalDroppedMessages} messages dropped by sliding window — agent lost earlier context`,
      details: contextDiffs
        .filter(d => {
          const df = d.data.diff as { droppedMessages?: number } | undefined;
          return (df?.droppedMessages ?? 0) > 0;
        })
        .map(d => {
          const df = d.data.diff as { droppedMessages?: number } | undefined;
          return `Iteration ${d.iteration}: ${df?.droppedMessages ?? 0} dropped`;
        })
        .join(', '),
    });
  }

  if (truncatedToolOutputs > 0) {
    issues.push({
      severity: 'info',
      category: 'context',
      message: `${truncatedToolOutputs} tool outputs were truncated (>8KB) before sending to LLM`,
    });
  }

  // === Tool Usage ===
  const toolStarts = normalized.filter(e => e.type === 'tool:start' || e.type === 'tool_call');
  const toolEnds = normalized.filter(e => e.type === 'tool:end' || e.type === 'tool:execution' || e.type === 'tool_result');
  const toolErrors = normalized.filter(e =>
    e.type === 'tool:error'
      || (e.type === 'tool:end' && e.data?.success === false)
      || (e.type === 'tool:execution' && (e.raw as ToolRawEvent).output?.success === false)
      || (e.type === 'tool_result' && e.data?.success === false)
  );

  const toolBreakdown: Record<string, { calls: number; failures: number; totalDurationMs: number }> = {};
  const slowCalls: Array<{ tool: string; durationMs: number; iteration: number; args: string }> = [];
  const SLOW_THRESHOLD_MS = 5000; // 5s threshold for "slow" calls

  for (const te of toolEnds) {
    const data = (te.data || te.raw) as GenericRawData;
    const name = data.toolName || data.tool?.name || 'unknown';
    const dur = Number(data.durationMs) || Number(data.timing?.durationMs) || 0;
    const success = data.success ?? data.output?.success ?? true;

    if (!toolBreakdown[name]) {
      toolBreakdown[name] = { calls: 0, failures: 0, totalDurationMs: 0 };
    }
    toolBreakdown[name].calls++;
    toolBreakdown[name].totalDurationMs += dur;
    if (!success) {toolBreakdown[name].failures++;}

    // Track slow calls (>5s)
    if (dur > SLOW_THRESHOLD_MS) {
      const args = data.input ? JSON.stringify(data.input).slice(0, 100) : '';
      slowCalls.push({
        tool: name,
        durationMs: dur,
        iteration: te.iteration || Number(data.iteration) || 0,
        args,
      });
    }
  }

  const toolBreakdownFinal: Record<string, { calls: number; failures: number; avgDurationMs: number }> = {};
  for (const [name, stats] of Object.entries(toolBreakdown)) {
    toolBreakdownFinal[name] = {
      calls: stats.calls,
      failures: stats.failures,
      avgDurationMs: stats.calls > 0 ? Math.round(stats.totalDurationMs / stats.calls) : 0,
    };
  }

  // Tool failure issues
  for (const err of toolErrors) {
    const data = (err.data || err.raw) as GenericRawData;
    const name = data.toolName || data.tool?.name || 'unknown';
    const rawErr = data.error;
    const errMsg = typeof rawErr === 'string' ? rawErr : rawErr?.message || data.output?.error?.message || '';
    issues.push({
      severity: 'warning',
      category: 'tool',
      message: `Tool "${name}" failed: ${typeof errMsg === 'string' ? errMsg.slice(0, 200) : JSON.stringify(errMsg).slice(0, 200)}`,
      iteration: Number(data.iteration) || err.iteration,
    });
  }

  // === LLM Behavior ===
  const llmResponses = normalized.filter(e => e.type === 'llm:end' || e.type === 'llm_response');
  const llmCalls = normalized.filter(e => e.type === 'llm:start' || e.type === 'llm:call' || e.type === 'llm_call');
  let emptyResponses = 0;
  const reasoningTexts: DiagnosticReport['llmBehavior']['reasoningTexts'] = [];

  for (const lr of llmResponses) {
    const data = (lr.data || lr.raw) as LLMRawEvent;
    const content = data.content || '';
    const hasToolCalls = data.hasToolCalls || false;

    if (!content && !hasToolCalls) {
      emptyResponses++;
      issues.push({
        severity: 'warning',
        category: 'llm',
        message: 'LLM returned empty response (no text, no tool calls)',
        iteration: lr.iteration || Number(data.iteration) || 0,
      });
    }

    // Capture reasoning text (text before tool calls)
    if (content && content.length > 5 && content !== '[Executing tools...]') {
      reasoningTexts.push({
        iteration: lr.iteration || Number(data.iteration) || 0,
        preview: content.slice(0, 300),
      });
    }
  }

  // Stopping analysis
  const stoppingAnalyses = normalized.filter(e => e.type === 'stopping:analysis');
  const stoppingReasons = stoppingAnalyses
    .map(e => String(e.data.reasoning ?? ''))
    .filter(Boolean);

  // === Error Detection ===
  const errors = normalized.filter(e => e.type === 'error:captured' || e.type === 'agent:error');
  for (const err of errors) {
    const data = (err.data || err.raw) as ErrorRawEvent;
    const rawErr = data.error;
    const msg = typeof rawErr === 'string' ? rawErr : rawErr?.message || '';
    const errStack = typeof rawErr === 'object' && rawErr !== null ? rawErr.stack : undefined;
    issues.push({
      severity: 'critical',
      category: 'error',
      message: msg.slice(0, 300),
      iteration: Number(data.iteration) || err.iteration,
      details: errStack || data.agentStack ? JSON.stringify(data.agentStack ?? {}).slice(0, 200) : undefined,
    });
  }

  // === Loop Detection ===
  let loopDetected = false;
  const repeatedPatterns: string[] = [];

  // Check for repeated tool call patterns
  const toolCallSequence = toolStarts
    .map(e => {
      const data = (e.data || e.raw) as GenericRawData;
      return data.toolName || data.tool?.name || 'unknown';
    });

  if (toolCallSequence.length >= 6) {
    // Check last 6 calls for repeating patterns of 3
    for (let windowSize = 2; windowSize <= 3; windowSize++) {
      const lastN = toolCallSequence.slice(-windowSize * 2);
      const first = lastN.slice(0, windowSize).join(',');
      const second = lastN.slice(windowSize).join(',');
      if (first === second) {
        loopDetected = true;
        repeatedPatterns.push(first);
        issues.push({
          severity: 'warning',
          category: 'loop',
          message: `Repeated tool pattern detected: ${first} (called ${windowSize} times in a row)`,
        });
      }
    }
  }

  // === Quality Issues ===
  if (!success) {
    issues.push({
      severity: 'critical',
      category: 'quality',
      message: 'Task failed — agent did not produce a successful result',
    });
  }

  if (confidence > 0 && confidence < 0.5) {
    issues.push({
      severity: 'warning',
      category: 'quality',
      message: `Low confidence: ${confidence} — agent was not confident in its answer`,
    });
  }

  if (iterations >= 20) {
    issues.push({
      severity: 'warning',
      category: 'quality',
      message: `Used ${iterations} iterations — may indicate difficulty finding answer`,
    });
  }

  // Sort issues: critical first, then warning, then info
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    taskId,
    summary: {
      totalEvents: events.length,
      iterations,
      totalTokens,
      durationMs,
      success,
      confidence,
    },
    issues,
    contextHealth: {
      maxContextChars,
      maxContextTokens: Math.round(maxContextChars / 4),
      totalDroppedMessages,
      truncatedToolOutputs,
      contextGrowthHistory,
      tokenGrowth,
      systemPromptChanges,
    },
    toolUsage: {
      totalCalls: Object.values(toolBreakdownFinal).reduce((sum, t) => sum + t.calls, 0),
      failures: Object.values(toolBreakdownFinal).reduce((sum, t) => sum + t.failures, 0),
      toolBreakdown: toolBreakdownFinal,
      slowCalls: slowCalls.sort((a, b) => b.durationMs - a.durationMs),
    },
    llmBehavior: {
      totalCalls: llmCalls.length,
      emptyResponses,
      reasoningTexts,
      stoppingReasons,
    },
    loopDetection: {
      detected: loopDetected,
      repeatedPatterns,
    },
  };
}

function printReport(ctx: PluginCommandContextV3, report: DiagnosticReport): void {
  const { summary, issues, contextHealth, toolUsage, llmBehavior, loopDetection } = report;

  ctx.ui.write('\n');
  ctx.ui.write('=' .repeat(60) + '\n');
  ctx.ui.write(`  DIAGNOSTIC REPORT: ${report.taskId}\n`);
  ctx.ui.write('=' .repeat(60) + '\n');

  // Summary
  const status = summary.success ? '  OK' : '  FAILED';
  ctx.ui.write(`\n${status}\n`);
  ctx.ui.write(`  Iterations: ${summary.iterations} | Tokens: ${summary.totalTokens} | Time: ${(summary.durationMs / 1000).toFixed(1)}s`);
  if (summary.confidence > 0) {ctx.ui.write(` | Confidence: ${summary.confidence}`);}
  ctx.ui.write('\n');

  // Issues
  if (issues.length > 0) {
    ctx.ui.write('\n--- Issues (' + issues.length + ') ---\n');
    for (const issue of issues) {
      const icon = issue.severity === 'critical' ? 'X' : issue.severity === 'warning' ? '!' : 'i';
      const iter = issue.iteration ? ` [iter ${issue.iteration}]` : '';
      ctx.ui.write(`  [${icon}] ${issue.category}: ${issue.message}${iter}\n`);
      if (issue.details) {
        ctx.ui.write(`      ${issue.details.slice(0, 150)}\n`);
      }
    }
  } else {
    ctx.ui.write('\n  No issues detected.\n');
  }

  // Context Health
  ctx.ui.write('\n--- Context Window ---\n');
  ctx.ui.write(`  Max context: ~${contextHealth.maxContextTokens} tokens (${contextHealth.maxContextChars} chars)\n`);
  ctx.ui.write(`  Dropped messages: ${contextHealth.totalDroppedMessages}\n`);
  ctx.ui.write(`  Truncated outputs: ${contextHealth.truncatedToolOutputs}\n`);

  if (contextHealth.contextGrowthHistory.length > 0) {
    ctx.ui.write('  Growth: ');
    ctx.ui.write(contextHealth.contextGrowthHistory
      .map(g => `iter${g.iteration}=${g.messageCount}msg/${Math.round(g.totalChars/1000)}K` +
        (g.droppedMessages > 0 ? `(-${g.droppedMessages})` : ''))
      .join(' -> '));
    ctx.ui.write('\n');
  }

  if (contextHealth.tokenGrowth.length > 0) {
    ctx.ui.write('  Tokens: ');
    ctx.ui.write(contextHealth.tokenGrowth
      .map(t => `iter${t.iteration}=${t.cumulativeTokens}`)
      .join(' -> '));
    ctx.ui.write('\n');
  }

  if (contextHealth.systemPromptChanges.length > 0) {
    ctx.ui.write('  System prompt changes:\n');
    for (const sp of contextHealth.systemPromptChanges) {
      ctx.ui.write(`    iter${sp.iteration}: ${sp.charsDelta > 0 ? '+' : ''}${sp.charsDelta} chars\n`);
    }
  }

  // Tool Usage
  ctx.ui.write('\n--- Tools ---\n');
  ctx.ui.write(`  Total calls: ${toolUsage.totalCalls} | Failures: ${toolUsage.failures}\n`);
  const entries = Object.entries(toolUsage.toolBreakdown)
    .sort((a, b) => b[1].calls - a[1].calls);
  for (const [name, stats] of entries) {
    const fail = stats.failures > 0 ? ` (${stats.failures} failed)` : '';
    ctx.ui.write(`    ${name}: ${stats.calls}x avg ${stats.avgDurationMs}ms${fail}\n`);
  }

  // Slow calls
  if (toolUsage.slowCalls.length > 0) {
    ctx.ui.write('  Slow calls (>5s):\n');
    for (const sc of toolUsage.slowCalls) {
      const durStr = sc.durationMs >= 60000
        ? `${(sc.durationMs / 60000).toFixed(1)}min`
        : `${(sc.durationMs / 1000).toFixed(1)}s`;
      ctx.ui.write(`    [iter ${sc.iteration}] ${sc.tool} ${durStr}${sc.args ? ` args=${sc.args}` : ''}\n`);
    }
  }

  // LLM Behavior
  ctx.ui.write('\n--- LLM ---\n');
  ctx.ui.write(`  Calls: ${llmBehavior.totalCalls} | Empty responses: ${llmBehavior.emptyResponses}\n`);

  if (llmBehavior.reasoningTexts.length > 0) {
    ctx.ui.write('  Reasoning:\n');
    for (const rt of llmBehavior.reasoningTexts.slice(0, 5)) {
      const preview = rt.preview.replace(/\n/g, ' ').slice(0, 120);
      ctx.ui.write(`    [iter ${rt.iteration}] "${preview}"\n`);
    }
  }

  if (llmBehavior.stoppingReasons.length > 0) {
    ctx.ui.write('  Stop reasons: ' + [...new Set(llmBehavior.stoppingReasons)].join(', ') + '\n');
  }

  // Loop Detection
  if (loopDetection.detected) {
    ctx.ui.write('\n--- Loop Detection ---\n');
    ctx.ui.write(`  LOOP DETECTED: ${loopDetection.repeatedPatterns.join('; ')}\n`);
  }

  ctx.ui.write('\n' + '=' .repeat(60) + '\n\n');
}

function mkError(code: TraceErrorCode, message: string): TraceCommandResponse {
  return {
    success: false,
    command: 'trace:diagnose',
    taskId: '',
    error: { code, message },
    summary: { message, severity: 'error', actionable: true },
  };
}
