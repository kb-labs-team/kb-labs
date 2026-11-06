/**
 * AI-friendly response types for trace CLI commands
 *
 * All trace commands support --json flag and return structured responses
 * with this format for agent-to-agent debugging.
 */

import type { DetailedTraceEntry } from './detailed-trace-types.js';

// ═══════════════════════════════════════════════════════════════════════
// Base Response Interface
// ═══════════════════════════════════════════════════════════════════════

/**
 * Base response for all trace commands (AI-friendly)
 */
export interface TraceCommandResponse<T = unknown> {
  /** Whether command succeeded */
  success: boolean;

  /** Command name (e.g., "trace:stats") */
  command: string;

  /** Task ID that was analyzed */
  taskId: string;

  /** Command-specific data */
  data?: T;

  /** Error details (if success = false) */
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };

  /** Summary for quick reading */
  summary: {
    /** One-liner summary */
    message: string;
    /** Severity level */
    severity: 'info' | 'warning' | 'error' | 'critical';
    /** Whether user should take action */
    actionable: boolean;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Command-Specific Response Types
// ═══════════════════════════════════════════════════════════════════════

/**
 * trace:stats response
 */
export interface StatsResponse {
  taskId: string;
  status: 'success' | 'failed' | 'incomplete';

  iterations: {
    total: number;
    completed: number;
  };

  llm: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };

  tools: {
    totalCalls: number;
    byTool: Record<string, number>;
    successful: number;
    failed: number;
  };

  timing: {
    startedAt: string;
    completedAt: string;
    totalDurationMs: number;
    durationFormatted: string; // "5m 30s"
  };

  cost: {
    total: number;
    currency: 'USD';
  };

  errors: number;
}

/**
 * trace:filter response
 */
export interface FilterResponse {
  taskId: string;
  eventType: string;
  events: DetailedTraceEntry[];
  count: number;
}

/**
 * trace:tail response
 */
export interface TailResponse {
  taskId: string;
  lines: number;
  events: DetailedTraceEntry[];
}

/**
 * trace:iteration response
 */
export interface IterationResponse {
  taskId: string;
  iteration: number;
  events: DetailedTraceEntry[];
  summary: {
    eventCount: number;
    llmCalls: number;
    toolCalls: number;
    errors: number;
    durationMs: number;
  };
}

/**
 * trace:analyze response (pattern detection)
 */
export interface AnalyzeResponse {
  taskId: string;

  issues: Array<{
    type: 'retry_loop' | 'tool_filtering_issue' | 'context_loss' | 'premature_stop';
    severity: 'low' | 'medium' | 'high' | 'critical';
    occurrences: number;
    iterations: number[];
    pattern: string;
    cause: string;
    fix: string;
    examples: unknown[];
  }>;

  recommendations: Array<{
    priority: 'low' | 'medium' | 'high' | 'critical';
    action: string;
    rationale: string;
  }>;

  metrics: {
    efficiencyScore: number; // 0-1
    retryRate: number; // Percentage of operations retried
    contextRetention: number; // Percentage of context preserved
    toolUtilization: number; // Percentage of tools used
  };
}

/**
 * trace:compare response
 */
export interface CompareResponse {
  taskId1: string;
  taskId2: string;

  differences: {
    iterations: {
      task1: number;
      task2: number;
      delta: number;
    };

    llmCalls: {
      task1: number;
      task2: number;
      delta: number;
    };

    toolCalls: {
      task1: number;
      task2: number;
      delta: number;
    };

    cost: {
      task1: number;
      task2: number;
      delta: number;
      deltaPercent: number;
    };

    duration: {
      task1: number;
      task2: number;
      delta: number;
      deltaPercent: number;
    };
  };

  divergencePoints: Array<{
    iteration: number;
    reason: string;
    task1Event: unknown;
    task2Event: unknown;
  }>;

  summary: {
    similar: boolean;
    majorDifferences: string[];
  };
}

/**
 * trace:snapshot response
 */
export interface SnapshotResponse {
  taskId: string;
  iteration: number;
  timestamp: string;

  snapshot: {
    messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }>;

    memory: {
      facts: string[];
      findings: string[];
      filesRead: string[];
      toolsUsed: Record<string, number>;
    };

    config: {
      maxIterations: number;
      mode: string;
      temperature: number;
    };

    availableTools: string[];
  };

  restoration: {
    canRestore: boolean;
    requiredData: string[];
  };
}

/**
 * trace:export response
 */
export interface ExportResponse {
  taskId: string;
  format: 'json' | 'markdown' | 'html';
  outputFile: string;
  size: number; // bytes
  eventCount: number;
}

/**
 * trace:replay response (for programmatic replay)
 */
export interface ReplayResponse {
  taskId: string;
  iterations: Array<{
    iteration: number;
    timestamp: string;
    events: DetailedTraceEntry[];
    summary: string;
  }>;
  totalDurationMs: number;
}

// ═══════════════════════════════════════════════════════════════════════
// Error Codes
// ═══════════════════════════════════════════════════════════════════════

/**
 * Standard error codes for trace commands
 */
export const TraceErrorCodes = {
  TRACE_NOT_FOUND: 'TRACE_NOT_FOUND',
  INVALID_TASK_ID: 'INVALID_TASK_ID',
  INVALID_EVENT_TYPE: 'INVALID_EVENT_TYPE',
  INVALID_ITERATION: 'INVALID_ITERATION',
  CORRUPTED_TRACE: 'CORRUPTED_TRACE',
  IO_ERROR: 'IO_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
  MISSING_INDEX: 'MISSING_INDEX',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
} as const;

export type TraceErrorCode = (typeof TraceErrorCodes)[keyof typeof TraceErrorCodes];
