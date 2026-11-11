/**
 * Helper functions for creating detailed trace events
 */

/* eslint-disable @typescript-eslint/consistent-type-imports */
/* eslint-disable sonarjs/no-duplicate-string */
// Using import() in return types to avoid circular dependencies
// Dynamic import syntax required for type-only imports in signatures

import type {
  IterationDetailEvent,
  LLMCallEvent,
  ToolExecutionEvent,
  MemorySnapshotEvent,
  DecisionPointEvent,
  SynthesisForcedTraceEvent,
  ErrorCapturedEvent,
  FactAddedEvent,
  ArchiveStoreEvent,
  SummarizationResultEvent,
  SummarizationLLMCallEvent,
} from '../contracts/index.js';
import type { LLMMessage, LLMToolCall, LLMToolCallResponse } from '@kb-labs/sdk';

/**
 * Create iteration:detail event
 */
export function createIterationDetailEvent(params: {
  iteration: number;
  maxIterations: number;
  mode: 'instant' | 'auto' | 'thinking';
  temperature: number;
  availableTools: string[];
  messages: LLMMessage[];
  totalTokens: number;
}): Omit<IterationDetailEvent, 'seq' | 'timestamp'> {
  return {
    type: 'iteration:detail',
    iteration: params.iteration,
    config: {
      maxIterations: params.maxIterations,
      mode: params.mode,
      temperature: params.temperature,
    },
    availableTools: {
      total: params.availableTools.length,
      tools: params.availableTools,
    },
    context: {
      messagesCount: params.messages.length,
      totalTokens: params.totalTokens,
      conversationSummary: params.messages
        .slice(-2)
        .map((m) => `${m.role}: ${m.content?.substring(0, 100) || ''}`)
        .join(' | '),
    },
  };
}

/**
 * Create llm:call event
 */
export function createLLMCallEvent(params: {
  iteration: number;
  model: string;
  temperature: number;
  maxTokens: number;
  tools: string[];
  response: LLMToolCallResponse;
  startTime: number;
  endTime: number;
}): Omit<LLMCallEvent, 'seq' | 'timestamp'> {
  const durationMs = params.endTime - params.startTime;

  // Calculate cost (simple estimation - can be improved with actual pricing)
  const inputCost = (params.response.usage?.promptTokens || 0) * 0.000003; // $3 per 1M tokens
  const outputCost = (params.response.usage?.completionTokens || 0) * 0.000015; // $15 per 1M tokens

  return {
    type: 'llm:call',
    iteration: params.iteration,
    request: {
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      tools: params.tools,
    },
    response: {
      content: params.response.content || null,
      toolCalls: params.response.toolCalls?.map((tc: LLMToolCall) => ({
        id: tc.id,
        name: tc.name,
        input: tc.input as Record<string, unknown>,
      })),
      stopReason: params.response.toolCalls && params.response.toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage: {
        inputTokens: params.response.usage.promptTokens,
        outputTokens: params.response.usage.completionTokens,
        totalTokens: params.response.usage.promptTokens + params.response.usage.completionTokens,
      },
    },
    timing: {
      startedAt: new Date(params.startTime).toISOString(),
      completedAt: new Date(params.endTime).toISOString(),
      durationMs,
    },
    cost: {
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
      currency: 'USD',
    },
  };
}

/**
 * Create tool:execution event
 */
export function createToolExecutionEvent(params: {
  iteration: number;
  toolName: string;
  callId: string;
  input: unknown;
  output: {
    success: boolean;
    result?: unknown;
    error?: {
      message: string;
      code?: string;
      stack?: string;
    };
  };
  startTime: number;
  endTime: number;
  metadata?: Record<string, unknown>;
}): Omit<ToolExecutionEvent, 'seq' | 'timestamp'> {
  const durationMs = params.endTime - params.startTime;

  // Record full output for tracing (up to 50KB), with truncation flag
  const resultStr = typeof params.output.result === 'string'
    ? params.output.result
    : JSON.stringify(params.output.result || '');
  const TRACE_OUTPUT_LIMIT = 50000; // 50KB — generous for debugging
  const truncated = resultStr.length > TRACE_OUTPUT_LIMIT;

  return {
    type: 'tool:execution',
    iteration: params.iteration,
    tool: {
      name: params.toolName,
      callId: params.callId,
    },
    input: params.input as Record<string, unknown>,
    output: {
      success: params.output.success,
      result: truncated ? resultStr.substring(0, TRACE_OUTPUT_LIMIT) + `\n... (truncated from ${resultStr.length} chars)` : params.output.result,
      error: params.output.error,
      truncated,
      originalLength: resultStr.length,
    },
    timing: {
      startedAt: new Date(params.startTime).toISOString(),
      completedAt: new Date(params.endTime).toISOString(),
      durationMs,
    },
    metadata: params.metadata,
  };
}

/**
 * Create memory:snapshot event
 */
export function createMemorySnapshotEvent(params: {
  iteration: number;
  conversationHistory: number;
  userPreferences: Record<string, unknown>;
  facts: string[];
  findings: string[];
  filesRead: string[];
  searchesMade: number;
  toolsUsed: Record<string, number>;
}): Omit<MemorySnapshotEvent, 'seq' | 'timestamp'> {
  return {
    type: 'memory:snapshot',
    iteration: params.iteration,
    sessionMemory: {
      conversationHistory: params.conversationHistory,
      userPreferences: params.userPreferences,
    },
    sharedMemory: {
      facts: params.facts,
      findings: params.findings,
    },
    executionMemory: {
      filesRead: params.filesRead,
      searchesMade: params.searchesMade,
      toolsUsed: params.toolsUsed,
    },
  };
}

/**
 * Create decision:point event
 */
export function createDecisionPointEvent(params: {
  iteration: number;
  decision: 'tool_selection' | 'stopping_condition' | 'synthesis';
  toolSelection?: {
    chosenTool: string;
    reasoning: string;
    alternatives: Array<{ tool: string; reason: string }>;
  };
  stoppingCondition?: {
    shouldStop: boolean;
    reason: string;
  };
}): Omit<DecisionPointEvent, 'seq' | 'timestamp'> {
  return {
    type: 'decision:point',
    iteration: params.iteration,
    decision: params.decision,
    toolSelection: params.toolSelection,
    stoppingCondition: params.stoppingCondition,
  };
}

/**
 * Create synthesis:forced event
 */
export function createSynthesisForcedEvent(params: {
  iteration: number;
  reason: 'last_iteration' | 'max_iterations' | 'no_tool_call' | 'user_request';
  lastIteration: number;
  lastToolCall?: string;
  synthesisPrompt: string;
  synthesisResponse: {
    content: string;
    tokens: number;
    durationMs: number;
  };
}): Omit<SynthesisForcedTraceEvent, 'seq' | 'timestamp'> {
  return {
    type: 'synthesis:forced',
    iteration: params.iteration,
    trigger: {
      reason: params.reason,
      lastIteration: params.lastIteration,
      lastToolCall: params.lastToolCall,
    },
    synthesisPrompt: params.synthesisPrompt,
    synthesisResponse: params.synthesisResponse,
  };
}

/**
 * Create error:captured event
 */
export function createErrorCapturedEvent(params: {
  iteration: number;
  error: Error;
  lastLLMCall?: {
    request: unknown;
    response: unknown;
    durationMs: number;
  };
  lastToolCall?: {
    name: string;
    input: unknown;
    output?: unknown;
    error?: string;
  };
  currentMessages: LLMMessage[];
  memoryState: {
    filesRead: string[];
    searchesMade: number;
  };
  availableTools: string[];
  agentStack: {
    currentPhase?: string;
    currentStep?: string;
    iterationHistory: number[];
  };
}): Omit<ErrorCapturedEvent, 'seq' | 'timestamp'> {
  return {
    type: 'error:captured',
    iteration: params.iteration,
    error: {
      message: params.error.message,
      stack: params.error.stack || '',
      code: (params.error as unknown as { code?: string }).code,
      name: params.error.name,
    },
    context: {
      lastLLMCall: params.lastLLMCall as { request: Record<string, unknown>; response: Record<string, unknown>; durationMs: number } | undefined,
      lastToolCall: params.lastToolCall as { name: string; input: Record<string, unknown>; output?: unknown; error?: string } | undefined,
      currentMessages: params.currentMessages.slice(-5).map((m) => ({
        role: (m.role === 'tool' ? 'assistant' : m.role) as 'system' | 'user' | 'assistant',
        contentPreview: m.content?.substring(0, 100) || '',
      })),
      memoryState: params.memoryState,
      availableTools: params.availableTools,
    },
    agentStack: params.agentStack,
  };
}

/**
 * Create prompt:diff event
 */
export function createPromptDiffEvent(params: {
  iteration: number;
  messagesAdded: number;
  messagesRemoved: number;
  totalMessages: number;
  changes: Array<{
    type: 'added' | 'removed' | 'modified';
    role: 'system' | 'user' | 'assistant';
    contentPreview: string;
    index: number;
  }>;
  tokensBefore: number;
  tokensAfter: number;
}): Omit<import('../contracts/index.js').PromptDiffEvent, 'seq' | 'timestamp'> {
  return {
    type: 'prompt:diff',
    iteration: params.iteration,
    diff: {
      messagesAdded: params.messagesAdded,
      messagesRemoved: params.messagesRemoved,
      totalMessages: params.totalMessages,
      changes: params.changes,
      contextGrowth: {
        tokensBefore: params.tokensBefore,
        tokensAfter: params.tokensAfter,
        delta: params.tokensAfter - params.tokensBefore,
      },
    },
  };
}

/**
 * Create tool:filter event
 */
export function createToolFilterEvent(params: {
  iteration: number;
  beforeTools: string[];
  afterTools: string[];
  filtered: Array<{
    name: string;
    reason: 'last_iteration' | 'mode_restriction' | 'tier_restriction' | 'custom';
    explanation: string;
  }>;
}): Omit<import('../contracts/index.js').ToolFilterEvent, 'seq' | 'timestamp'> {
  return {
    type: 'tool:filter',
    iteration: params.iteration,
    filtering: {
      before: {
        totalTools: params.beforeTools.length,
        tools: params.beforeTools,
      },
      after: {
        totalTools: params.afterTools.length,
        tools: params.afterTools,
      },
      filtered: params.filtered,
    },
  };
}

/**
 * Create context:trim event
 */
export function createContextTrimEvent(params: {
  iteration: number;
  trigger: 'max_tokens' | 'max_messages' | 'manual';
  messageCountBefore: number;
  messageCountAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  messagesRemoved: number;
  tokensRemoved: number;
  contentPreview: string;
  strategy: 'sliding_window' | 'summarization' | 'importance_based';
}): Omit<import('../contracts/index.js').ContextTrimEvent, 'seq' | 'timestamp'> {
  return {
    type: 'context:trim',
    iteration: params.iteration,
    trimming: {
      trigger: params.trigger,
      before: {
        messageCount: params.messageCountBefore,
        estimatedTokens: params.tokensBefore,
      },
      after: {
        messageCount: params.messageCountAfter,
        estimatedTokens: params.tokensAfter,
      },
      removed: {
        messageCount: params.messagesRemoved,
        tokensRemoved: params.tokensRemoved,
        contentPreview: params.contentPreview,
      },
      strategy: params.strategy,
    },
  };
}

/**
 * Create stopping:analysis event
 */
export function createStoppingAnalysisEvent(params: {
  iteration: number;
  conditions: {
    maxIterationsReached: boolean;
    timeoutReached: boolean;
    foundTarget: boolean;
    sufficientContext: boolean;
    diminishingReturns: boolean;
    userInterrupt: boolean;
    error: boolean;
  };
  reasoning: string;
  iterationsUsed: number;
  iterationsRemaining: number;
  timeElapsedMs: number;
  timeRemainingMs?: number;
  toolCallsInLast3Iterations: number;
  confidenceScore?: number;
}): Omit<import('../contracts/index.js').StoppingAnalysisEvent, 'seq' | 'timestamp'> {
  return {
    type: 'stopping:analysis',
    iteration: params.iteration,
    conditions: params.conditions,
    reasoning: params.reasoning,
    metrics: {
      iterationsUsed: params.iterationsUsed,
      iterationsRemaining: params.iterationsRemaining,
      timeElapsedMs: params.timeElapsedMs,
      timeRemainingMs: params.timeRemainingMs,
      toolCallsInLast3Iterations: params.toolCallsInLast3Iterations,
      confidenceScore: params.confidenceScore,
    },
  };
}

/**
 * Create llm:validation event
 */
export function createLLMValidationEvent(params: {
  iteration: number;
  stopReason: 'tool_use' | 'end_turn' | 'max_tokens' | 'stop_sequence';
  isValid: boolean;
  hasContent: boolean;
  hasToolCalls: boolean;
  toolCallsValid: boolean;
  jsonParseable: boolean;
  schemaValid: boolean;
  issues: Array<{
    severity: 'error' | 'warning' | 'info';
    check: string;
    message: string;
    recovery?: string;
  }>;
}): Omit<import('../contracts/index.js').LLMValidationEvent, 'seq' | 'timestamp'> {
  return {
    type: 'llm:validation',
    iteration: params.iteration,
    validation: {
      stopReason: params.stopReason,
      isValid: params.isValid,
      checks: {
        hasContent: params.hasContent,
        hasToolCalls: params.hasToolCalls,
        toolCallsValid: params.toolCallsValid,
        jsonParseable: params.jsonParseable,
        schemaValid: params.schemaValid,
      },
      issues: params.issues,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Two-Tier Memory Events
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create memory:fact_added event
 */
export function createFactAddedEvent(params: {
  iteration: number;
  fact: {
    id: string;
    category: string;
    fact: string;
    confidence: number;
    source: string;
    merged: boolean;
    superseded?: string;
  };
  factSheetStats: {
    totalFacts: number;
    estimatedTokens: number;
    byCategory: Record<string, number>;
  };
}): Omit<FactAddedEvent, 'seq' | 'timestamp'> {
  return {
    type: 'memory:fact_added',
    iteration: params.iteration,
    fact: params.fact,
    factSheetStats: params.factSheetStats,
  };
}

/**
 * Create memory:archive_store event
 */
export function createArchiveStoreEvent(params: {
  iteration: number;
  entry: {
    id: string;
    toolName: string;
    filePath?: string;
    outputLength: number;
    estimatedTokens: number;
    keyFactsExtracted: number;
  };
  archiveStats: {
    totalEntries: number;
    totalChars: number;
    uniqueFiles: number;
    evicted: number;
  };
}): Omit<ArchiveStoreEvent, 'seq' | 'timestamp'> {
  return {
    type: 'memory:archive_store',
    iteration: params.iteration,
    entry: params.entry,
    archiveStats: params.archiveStats,
  };
}

/**
 * Create memory:summarization_llm_call event.
 * Records the raw LLM interaction for fact extraction debugging.
 */
export function createSummarizationLLMCallEvent(params: {
  iteration: number;
  prompt: string;
  rawResponse: string;
  parseSuccess: boolean;
  parseError?: string;
  durationMs: number;
  outputTokens: number;
}): Omit<SummarizationLLMCallEvent, 'seq' | 'timestamp'> {
  return {
    type: 'memory:summarization_llm_call',
    iteration: params.iteration,
    prompt: params.prompt,
    rawResponse: params.rawResponse,
    parseSuccess: params.parseSuccess,
    parseError: params.parseError,
    timing: {
      durationMs: params.durationMs,
      outputTokens: params.outputTokens,
    },
  };
}

/**
 * Create memory:summarization_result event
 */
export function createSummarizationResultEvent(params: {
  iteration: number;
  input: {
    iterationRange: [number, number];
    messagesCount: number;
    inputChars: number;
    inputTokens: number;
  };
  output: {
    factsExtracted: number;
    factsByCategory: Record<string, number>;
    outputTokens: number;
    llmDurationMs: number;
  };
  delta: {
    factSheetBefore: number;
    factSheetAfter: number;
    tokensBefore: number;
    tokensAfter: number;
    newFacts: number;
    mergedFacts: number;
    evictedFacts: number;
  };
  efficiency: {
    compressionRatio: number;
    factDensity: number;
    newFactRate: number;
  };
}): Omit<SummarizationResultEvent, 'seq' | 'timestamp'> {
  return {
    type: 'memory:summarization_result',
    iteration: params.iteration,
    input: params.input,
    output: params.output,
    delta: params.delta,
    efficiency: params.efficiency,
  };
}
