/**
 * @module @kb-labs/agents/contracts/turn
 * Turn-based conversation schema for agent UI
 *
 * A Turn represents a complete interaction cycle (user message → agent response).
 * Backend assembles Turns from raw AgentEvents, frontend simply renders.
 */

/**
 * Lightweight summary of a file change for Turn.metadata.
 * Does not include before/after content to keep turn history compact.
 */
export interface FileChangeSummary {
  changeId: string;
  filePath: string;
  operation: 'write' | 'patch' | 'delete';
  timestamp: string;
  linesAdded?: number;
  linesRemoved?: number;
  /** True when the file was newly created by the agent */
  isNew: boolean;
  sizeAfter: number;
  approved?: boolean;
}

export interface RollbackResult {
  rolledBack: number;
  skipped: number;
  conflicts?: ConflictInfo[];
}

export interface ConflictInfo {
  filePath: string;
  changeId: string;
  reason: string;
}

/**
 * A turn represents a complete agent interaction cycle.
 * Assembled from multiple events by the backend.
 */
export interface Turn {
  /** Unique turn ID (derived from root agent run ID) */
  id: string;

  /** Turn type determines rendering strategy */
  type: 'user' | 'assistant' | 'system';

  /** Turn sequence number in session (1-based) */
  sequence: number;

  /** Timestamp of first event in turn */
  startedAt: string;

  /** Timestamp of last event in turn (null if incomplete) */
  completedAt: string | null;

  /** Turn completion status */
  status: 'streaming' | 'completed' | 'failed' | 'cancelled';

  /** Optional error if turn failed */
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };

  /** Ordered steps within this turn */
  steps: TurnStep[];

  /** Metadata for debugging */
  metadata: {
    agentId: string;
    agentName?: string;
    taskId?: string;
    totalTokens?: number;
    totalDurationMs?: number;
    /** Run ID that produced this assistant turn */
    runId?: string;
    /** Summary of files changed during this turn (populated on run completion) */
    fileChanges?: FileChangeSummary[];
    /**
     * Client-generated id echoed back on user turns, so the frontend can
     * reconcile its optimistic message by id instead of fuzzy text-matching.
     */
    clientId?: string;
  };
}

/**
 * Incremental change to a Turn, addressed by the session's monotonic `seq`.
 * The server emits these instead of resending the full Turn on every event —
 * the client applies them as ordered patches against its local turn map.
 * `turn:created` carries the turn WITHOUT steps; steps arrive via their own
 * `turn:step:appended` deltas (including any present at creation time).
 */
export type TurnDelta =
  | { kind: 'turn:created'; seq: number; turn: Turn }
  | { kind: 'turn:step:appended'; seq: number; turnId: string; step: TurnStep }
  | { kind: 'turn:step:updated'; seq: number; turnId: string; step: TurnStep }
  | { kind: 'turn:status'; seq: number; turnId: string; status: Turn['status']; completedAt: string | null; error?: Turn['error'] }
  | { kind: 'turn:metadata'; seq: number; turnId: string; patch: Partial<Turn['metadata']> };

/**
 * A step is a single action within a turn.
 * Maps to event types from the event stream.
 */
export type TurnStep =
  | ThinkingStep
  | ToolUseStep
  | ToolResultStep
  | SubAgentStep
  | TextStep
  | ErrorStep;

/** Agent reasoning/planning step */
export interface ThinkingStep {
  type: 'thinking';
  id: string;
  timestamp: string;
  content: string;
  /** Optional structured thinking (from extended_thinking) */
  structured?: {
    reasoning: string;
    nextActions: string[];
  };
}

/** Tool invocation step — unified: starts as pending, updated in-place when done */
export interface ToolUseStep {
  type: 'tool_use';
  id: string;
  timestamp: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Optional tool call ID for correlation */
  toolCallId?: string;
  /** Execution status — backend updates in-place on tool:end / tool:error */
  status: 'pending' | 'done' | 'error';
  /** Whether tool execution succeeded (false = tool returned an error result) */
  success?: boolean;
  /** Set when status = done */
  output?: unknown;
  /** Set when status = error */
  error?: string;
  /** Set when status = done */
  durationMs?: number;
  /**
   * Optional rich metadata from tool event — propagated from ToolEventMetadata.
   * Includes diff, filePath, resultCount, confidence, exitCode, etc.
   */
  metadata?: {
    /** File path being operated on */
    filePath?: string;
    /** File content (for fs:read) */
    fileContent?: string;
    /** Unified diff output (for fs:edit, fs:patch, fs:write) */
    diff?: string;
    /** Content before the change */
    oldContent?: string;
    /** Content after the change */
    newContent?: string;
    /** Lines changed count */
    linesChanged?: number;
    /** Lines added */
    linesAdded?: number;
    /** Lines removed */
    linesRemoved?: number;
    /** Search result count (for grep, glob, rag-query) */
    resultCount?: number;
    /** Search results */
    results?: unknown[];
    /** Search/RAG query text */
    query?: string;
    /** Confidence score 0-1 (for RAG queries) */
    confidence?: number;
    /** Exit code (for bash/shell tools) */
    exitCode?: number;
    /** Command that was executed */
    command?: string;
    /** Stdout output */
    stdout?: string;
    /** Stderr output */
    stderr?: string;
    /** Human-readable summary from the tool */
    summary?: string;
    /** UI rendering hint */
    uiHint?: 'code' | 'diff' | 'table' | 'json' | 'markdown' | 'plain' | 'todo';
    /** Any extra structured data */
    structured?: Record<string, unknown>;
  };
}

/**
 * @deprecated Use ToolUseStep with status field instead.
 * Kept for backward compatibility with old session data.
 */
export interface ToolResultStep {
  type: 'tool_result';
  id: string;
  timestamp: string;
  toolName: string;
  toolCallId?: string;
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

/** Sub-agent invocation (nested turn reference) */
export interface SubAgentStep {
  type: 'subagent';
  id: string;
  timestamp: string;
  /** Reference to nested turn ID */
  turnId: string;
  agentName: string;
  task: string;
  /** Status of sub-agent execution */
  status: 'running' | 'completed' | 'failed';
  /** Summary of sub-agent result (once completed) */
  summary?: string;
}

/** Plain text output step */
export interface TextStep {
  type: 'text';
  id: string;
  timestamp: string;
  content: string;
  /** Optional role (user/assistant/system) */
  role?: string;
}

/** Error step */
export interface ErrorStep {
  type: 'error';
  id: string;
  timestamp: string;
  code: string;
  message: string;
  details?: unknown;
}
