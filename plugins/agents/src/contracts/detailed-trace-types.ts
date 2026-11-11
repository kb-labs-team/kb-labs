/**
 * Detailed trace event types for incremental agent tracing
 *
 * This file defines 12 trace event types for comprehensive agent debugging:
 * - 6 core events: iteration:detail, llm:call, tool:execution, memory:snapshot, decision:point, synthesis:forced
 * - 6 debugging events: error:captured, prompt:diff, tool:filter, context:trim, stopping:analysis, llm:validation
 */

// ═══════════════════════════════════════════════════════════════════════
// Event Type Discriminator
// ═══════════════════════════════════════════════════════════════════════

export type TraceEventType =
  // Lifecycle events (agent:start/end, iteration:start/end, status:change come from AgentEvent in events.ts)
  | 'task:start'
  | 'task:end'
  // Core events
  | 'iteration:detail'
  | 'llm:call'
  | 'tool:execution'
  | 'memory:snapshot'
  | 'decision:point'
  | 'synthesis:forced'
  // Memory observability events
  | 'memory:fact_added'
  | 'memory:archive_store'
  | 'memory:summarization_result'
  | 'memory:summarization_llm_call'
  // Debugging events
  | 'error:captured'
  | 'prompt:diff'
  | 'tool:filter'
  | 'context:trim'
  | 'context:snapshot'
  | 'context:diff'
  | 'stopping:analysis'
  | 'llm:validation';

// ═══════════════════════════════════════════════════════════════════════
// Base TraceEntry (extended from types.ts)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Base trace entry for all events
 */
export interface BaseTraceEntry {
  /** Auto-increment sequence number (1, 2, 3...) */
  seq: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Event type discriminator */
  type: TraceEventType;
  /** Which iteration (1-based) - optional for non-iteration events */
  iteration?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// Lifecycle Trace Events (trace-only, not in AgentEvent stream)
// ═══════════════════════════════════════════════════════════════════════

/**
 * task:start — includes systemPrompt and available tools.
 * Complementary to agent:start (which is in AgentEvent/events.ts).
 */
export interface TaskStartEvent extends BaseTraceEntry {
  type: 'task:start';
  iteration: number;
  task: string;
  tier: string;
  systemPrompt: string;
  availableTools: Array<{ name: string; description: string }>;
}

/** task:end — final result summary at execution loop exit */
export interface TaskEndEvent extends BaseTraceEntry {
  type: 'task:end';
  iteration: number;
  success: boolean;
  stopped?: boolean;
  summary: string;
  error?: string;
  filesCreated: string[];
  filesModified: string[];
  filesRead: string[];
  totalIterations: number;
  totalTokens: number;
}

// ═══════════════════════════════════════════════════════════════════════
// Core Events (6)
// ═══════════════════════════════════════════════════════════════════════

/**
 * 1. iteration:detail - Full context at start of iteration
 */
export interface IterationDetailEvent extends BaseTraceEntry {
  type: 'iteration:detail';
  iteration: number;

  config: {
    maxIterations: number;
    mode: 'instant' | 'auto' | 'thinking';
    temperature: number;
  };

  availableTools: {
    total: number;
    tools: string[]; // ["fs:read", "grep_search", ...]
  };

  context: {
    messagesCount: number;
    totalTokens: number;
    conversationSummary: string; // First 200 chars of conversation
  };
}

/**
 * 2. llm:call - LLM request and response with cost tracking
 */
export interface LLMCallEvent extends BaseTraceEntry {
  type: 'llm:call';
  iteration: number;

  request: {
    model: string; // "claude-sonnet-4-5"
    temperature: number;
    maxTokens: number;
    tools: string[]; // Available tools for this call
  };

  response: {
    content: string | null; // Text response or null if tool_use
    toolCalls?: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>;
    stopReason: 'tool_use' | 'end_turn' | 'max_tokens' | 'stop_sequence';
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
  };

  timing: {
    startedAt: string; // ISO 8601
    completedAt: string;
    durationMs: number;
  };

  cost: {
    inputCost: number; // USD
    outputCost: number;
    totalCost: number;
    currency: 'USD';
  };
}

/**
 * 3. tool:execution - Tool call execution with result
 */
export interface ToolExecutionEvent extends BaseTraceEntry {
  type: 'tool:execution';
  iteration: number;

  tool: {
    name: string; // "fs:read"
    callId: string; // From LLM tool call
  };

  input: Record<string, unknown>; // Tool input params

  output: {
    success: boolean;
    result?: unknown; // Tool output if success
    error?: {
      message: string;
      code?: string;
      stack?: string;
    };
    truncated: boolean; // If output was truncated for storage
    originalLength?: number; // Original output length before truncation
  };

  timing: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
  };

  metadata?: {
    filesRead?: string[];
    searchesPerformed?: number;
    [key: string]: unknown;
  };
}

/**
 * 4. memory:snapshot - Memory state at point in time
 */
export interface MemorySnapshotEvent extends BaseTraceEntry {
  type: 'memory:snapshot';
  iteration: number;

  sessionMemory: {
    conversationHistory: number; // Count of messages
    userPreferences: Record<string, unknown>;
  };

  sharedMemory: {
    facts: string[]; // Key facts discovered
    findings: string[]; // Important findings
  };

  executionMemory: {
    filesRead: string[];
    searchesMade: number;
    toolsUsed: Record<string, number>; // {"fs:read": 5, "grep": 3}
  };

  /** Two-tier memory: FactSheet snapshot (Tier 1) */
  factSheet?: {
    totalFacts: number;
    estimatedTokens: number;
    byCategory: Record<string, number>;
  };

  /** Two-tier memory: ArchiveMemory snapshot (Tier 2) */
  archive?: {
    totalEntries: number;
    uniqueFiles: number;
    totalChars: number;
  };
}

/**
 * 5. decision:point - Agent decision reasoning
 */
export interface DecisionPointEvent extends BaseTraceEntry {
  type: 'decision:point';
  iteration: number;

  decision: 'tool_selection' | 'stopping_condition' | 'synthesis';

  toolSelection?: {
    chosenTool: string;
    reasoning: string; // Why this tool was chosen
    alternatives: Array<{
      tool: string;
      reason: string; // Why NOT chosen
    }>;
  };

  stoppingCondition?: {
    shouldStop: boolean;
    reason: string;
  };
}

/**
 * 6. synthesis:forced - Forced synthesis trace event
 */
export interface SynthesisForcedTraceEvent extends BaseTraceEntry {
  type: 'synthesis:forced';
  iteration: number;

  trigger: {
    reason: 'last_iteration' | 'max_iterations' | 'no_tool_call' | 'user_request';
    lastIteration: number;
    lastToolCall?: string;
  };

  synthesisPrompt: string; // Prompt sent to LLM for synthesis

  synthesisResponse: {
    content: string;
    tokens: number;
    durationMs: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Memory Observability Events (3)
// ═══════════════════════════════════════════════════════════════════════

/**
 * memory:fact_added - Emitted when a fact is added/merged in the FactSheet
 */
export interface FactAddedEvent extends BaseTraceEntry {
  type: 'memory:fact_added';
  iteration: number;

  fact: {
    id: string;
    category: string; // FactCategory
    fact: string;
    confidence: number;
    source: string; // tool name or 'llm_extraction'
    merged: boolean; // true if merged with existing fact (dedup)
    superseded?: string; // id of replaced fact
  };

  factSheetStats: {
    totalFacts: number;
    estimatedTokens: number; // estimated tokens after addition
    byCategory: Record<string, number>; // { file_content: 12, finding: 5, ... }
  };
}

/**
 * memory:archive_store - Emitted when a tool output is archived
 */
export interface ArchiveStoreEvent extends BaseTraceEntry {
  type: 'memory:archive_store';
  iteration: number;

  entry: {
    id: string;
    toolName: string;
    filePath?: string;
    outputLength: number; // chars in full output
    estimatedTokens: number;
    keyFactsExtracted: number; // heuristic facts extracted
  };

  archiveStats: {
    totalEntries: number;
    totalChars: number;
    uniqueFiles: number;
    evicted: number; // entries evicted by this store
  };
}

/**
 * memory:summarization_result - Emitted after each LLM fact extraction cycle
 */
export interface SummarizationResultEvent extends BaseTraceEntry {
  type: 'memory:summarization_result';
  iteration: number;

  input: {
    iterationRange: [number, number]; // [startIter, endIter]
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
    factSheetBefore: number; // facts count before
    factSheetAfter: number; // facts count after
    tokensBefore: number; // estimated tokens before
    tokensAfter: number; // estimated tokens after
    newFacts: number;
    mergedFacts: number;
    evictedFacts: number;
  };

  efficiency: {
    compressionRatio: number; // inputTokens / outputTokens
    factDensity: number; // factsExtracted / messagesCount
    newFactRate: number; // newFacts / factsExtracted
  };
}

/**
 * memory:summarization_llm_call - Raw LLM call made by SmartSummarizer.
 * Useful for debugging fact extraction quality: see exact prompt sent and
 * raw response received. Emitted alongside memory:summarization_result.
 */
export interface SummarizationLLMCallEvent extends BaseTraceEntry {
  type: 'memory:summarization_llm_call';
  iteration: number;

  /** Exact prompt sent to LLM (full text, untruncated) */
  prompt: string;

  /** Raw LLM response content before JSON parsing */
  rawResponse: string;

  /** Whether JSON parsing succeeded */
  parseSuccess: boolean;

  /** Parse error message if parsing failed */
  parseError?: string;

  timing: {
    durationMs: number;
    outputTokens: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Debugging Events (6)
// ═══════════════════════════════════════════════════════════════════════

/**
 * 7. error:captured - Error with full context
 */
export interface ErrorCapturedEvent extends BaseTraceEntry {
  type: 'error:captured';
  iteration: number;

  error: {
    message: string;
    stack: string;
    code?: string;
    name: string; // "TypeError", "ENOENT", etc.
  };

  context: {
    lastLLMCall?: {
      request: Record<string, unknown>;
      response: Record<string, unknown>;
      durationMs: number;
    };

    lastToolCall?: {
      name: string;
      input: Record<string, unknown>;
      output?: unknown;
      error?: string;
    };

    currentMessages: Array<{
      // Last 5 messages
      role: 'system' | 'user' | 'assistant';
      contentPreview: string; // First 100 chars
    }>;

    memoryState: {
      filesRead: string[];
      searchesMade: number;
    };

    availableTools: string[];
  };

  agentStack: {
    currentPhase?: string;
    currentStep?: string;
    iterationHistory: number[]; // [1, 2, 3, 4] - completed iterations
  };
}

/**
 * 8. prompt:diff - Changes to prompt between iterations
 */
export interface PromptDiffEvent extends BaseTraceEntry {
  type: 'prompt:diff';
  iteration: number;

  diff: {
    messagesAdded: number;
    messagesRemoved: number;
    totalMessages: number;

    changes: Array<{
      type: 'added' | 'removed' | 'modified';
      role: 'system' | 'user' | 'assistant';
      contentPreview: string; // First 100 chars
      index: number;
    }>;

    contextGrowth: {
      tokensBefore: number;
      tokensAfter: number;
      delta: number;
    };
  };
}

/**
 * 9. tool:filter - Tool filtering logic
 */
export interface ToolFilterEvent extends BaseTraceEntry {
  type: 'tool:filter';
  iteration: number;

  filtering: {
    before: {
      totalTools: number;
      tools: string[];
    };

    after: {
      totalTools: number;
      tools: string[];
    };

    filtered: Array<{
      name: string;
      reason: 'last_iteration' | 'mode_restriction' | 'tier_restriction' | 'custom';
      explanation: string;
    }>;
  };
}

/**
 * 10. context:trim - Context trimming/summarization
 */
export interface ContextTrimEvent extends BaseTraceEntry {
  type: 'context:trim';
  iteration: number;

  trimming: {
    trigger: 'max_tokens' | 'max_messages' | 'manual';

    before: {
      messageCount: number;
      estimatedTokens: number;
    };

    after: {
      messageCount: number;
      estimatedTokens: number;
    };

    removed: {
      messageCount: number;
      tokensRemoved: number;
      contentPreview: string; // What was lost (first 200 chars)
    };

    strategy: 'sliding_window' | 'summarization' | 'importance_based';
  };
}

/**
 * 10b. context:snapshot - Full context window snapshot before LLM call
 */
export interface ContextSnapshotEvent extends BaseTraceEntry {
  type: 'context:snapshot';
  iteration: number;

  messageCount: number;
  totalChars: number;
  estimatedTokens: number;
  toolCount: number;
  tier: string;

  slidingWindow: {
    fullHistorySize: number;
    windowedSize: number;
    droppedMessages: number;
  };

  messages: Array<{
    index: number;
    role: string;
    chars: number;
    truncated?: boolean;
    toolCalls?: string[];
    toolCallId?: string;
    preview?: string;
  }>;
}

/**
 * 11. stopping:analysis - Stopping condition analysis
 */
export interface StoppingAnalysisEvent extends BaseTraceEntry {
  type: 'stopping:analysis';
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

  reasoning: string; // Why agent is stopping/continuing

  metrics: {
    iterationsUsed: number;
    iterationsRemaining: number;
    timeElapsedMs: number;
    timeRemainingMs?: number;
    toolCallsInLast3Iterations: number;
    confidenceScore?: number; // 0-1, confidence in result
  };
}

/**
 * 12. llm:validation - LLM response validation
 */
export interface LLMValidationEvent extends BaseTraceEntry {
  type: 'llm:validation';
  iteration: number;

  validation: {
    stopReason: 'tool_use' | 'end_turn' | 'max_tokens' | 'stop_sequence';
    isValid: boolean;

    checks: {
      hasContent: boolean;
      hasToolCalls: boolean;
      toolCallsValid: boolean;
      jsonParseable: boolean;
      schemaValid: boolean;
    };

    issues: Array<{
      severity: 'error' | 'warning' | 'info';
      check: string;
      message: string;
      recovery?: string; // What was done to recover
    }>;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Union Type for All Events
// ═══════════════════════════════════════════════════════════════════════

/**
 * Discriminated union of all trace event types
 */
export type DetailedTraceEntry =
  // Lifecycle (trace-only)
  | TaskStartEvent
  | TaskEndEvent
  // Core
  | IterationDetailEvent
  | LLMCallEvent
  | ToolExecutionEvent
  | MemorySnapshotEvent
  | DecisionPointEvent
  | SynthesisForcedTraceEvent
  // Memory observability
  | FactAddedEvent
  | ArchiveStoreEvent
  | SummarizationResultEvent
  | SummarizationLLMCallEvent
  // Debugging
  | ErrorCapturedEvent
  | PromptDiffEvent
  | ToolFilterEvent
  | ContextTrimEvent
  | ContextSnapshotEvent
  | StoppingAnalysisEvent
  | LLMValidationEvent;
