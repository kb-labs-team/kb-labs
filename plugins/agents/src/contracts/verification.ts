/**
 * Verification types for agent responses
 *
 * Cross-tier verification system to detect hallucinations
 * and assess response quality.
 */

// ═══════════════════════════════════════════════════════════════════════
// Verification Results
// ═══════════════════════════════════════════════════════════════════════

/**
 * Warning codes for verification issues
 */
export type VerificationWarningCode =
  | 'UNVERIFIED_FILE'
  | 'UNVERIFIED_PACKAGE'
  | 'UNVERIFIED_CLASS'
  | 'UNVERIFIED_FUNCTION'
  | 'LOW_CONFIDENCE'
  | 'INCOMPLETE_ANSWER'
  | 'CONTRADICTION'
  | 'VERIFICATION_FAILED';

/**
 * Warning about potential issues in agent response
 */
export interface VerificationWarning {
  code: VerificationWarningCode;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Result of cross-tier verification
 */
export interface VerificationResult {
  /** Entities mentioned in answer (files, packages, classes) */
  mentions: string[];
  /** Mentions that were verified against tool results */
  verifiedMentions: string[];
  /** Mentions that could NOT be verified (potential hallucinations) */
  unverifiedMentions: string[];
  /** Overall confidence in answer correctness (0-1) */
  confidence: number;
  /** How complete is the answer (0-1) */
  completeness: number;
  /** Aspects of the question that weren't addressed */
  gaps: string[];
  /** Warnings about potential issues */
  warnings: VerificationWarning[];
  /** Brief reasoning for the assessment */
  reasoning: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Quality Metrics
// ═══════════════════════════════════════════════════════════════════════

/**
 * Quality metrics for agent response
 */
export interface QualityMetrics {
  /** Overall confidence in answer (0-1) */
  confidence: number;
  /** How complete relative to question (0-1) */
  completeness: number;
  /** Unanswered aspects */
  gaps: string[];
  /** Verifier's reasoning */
  reasoning: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Verification Input/Output (for cross-tier verifier)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Input for cross-tier verification
 */
export interface VerificationInput {
  /** Original task/question */
  task: string;
  /** Agent's final answer */
  answer: string;
  /** Summary of tool results (files read, commands run, etc.) */
  toolResultsSummary: string;
  /** List of files that were actually read */
  filesRead?: string[];
  /** Executor tier (to determine verifier tier) */
  executorTier?: 'small' | 'medium' | 'large';
}

/**
 * Raw output from verifier LLM (via tool call)
 */
export interface VerificationOutput {
  /** Entities mentioned in answer (files, packages, classes) */
  mentions: string[];
  /** Which mentions appear in tool results */
  verified: string[];
  /** Which mentions could NOT be verified */
  unverified: string[];
  /** Overall confidence in answer (0-1) */
  confidence: number;
  /** How complete is the answer (0-1) */
  completeness: number;
  /** What aspects of the question weren't addressed */
  gaps: string[];
  /** Potential issues found */
  warnings: string[];
  /** Brief reasoning for the assessment */
  reasoning: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Tool Results Summary (for verifier context)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Record of a single tool call and its result
 */
export interface ToolResultRecord {
  /** Tool name (e.g., 'fs:read', 'mind:rag-query') */
  tool: string;
  /** Input parameters */
  input: Record<string, unknown>;
  /** Tool output */
  output: string;
  /** When the tool was called */
  timestamp?: string;
}

/**
 * Summary of tool results for verifier
 */
export interface ToolResultsSummary {
  /** Human-readable summary for verifier */
  text: string;
  /** Files that were read */
  filesRead: string[];
  /** Files that were created/modified */
  filesWritten: string[];
  /** Commands that were executed */
  commandsRun: string[];
  /** Searches that were performed */
  searchQueries: string[];
}

// ═══════════════════════════════════════════════════════════════════════
// Verification Thresholds
// ═══════════════════════════════════════════════════════════════════════

/**
 * Thresholds for verification-based decisions
 */
export interface VerificationThresholds {
  /** Max unverified mentions before retry */
  maxUnverifiedMentions: number;
  /** Min confidence before reformulation */
  minConfidence: number;
  /** Min confidence to mark as uncertain */
  uncertainConfidence: number;
  /** Min completeness before follow-up tasks */
  minCompleteness: number;
  /** Max retries per subtask */
  maxRetries: number;
}

/**
 * Default verification thresholds
 */
export const DEFAULT_VERIFICATION_THRESHOLDS: VerificationThresholds = {
  maxUnverifiedMentions: 3,
  minConfidence: 0.4,
  uncertainConfidence: 0.6,
  minCompleteness: 0.6,
  maxRetries: 2,
};

// ═══════════════════════════════════════════════════════════════════════
// Verification Events
// ═══════════════════════════════════════════════════════════════════════

/**
 * Verification event data (for agent events)
 */
export interface VerificationEventData {
  /** Verification result */
  verification: VerificationResult;
  /** Which subtask/task was verified */
  taskId?: string;
  /** Executor tier used */
  executorTier?: 'small' | 'medium' | 'large';
  /** Verifier tier used */
  verifierTier?: 'small' | 'medium' | 'large';
  /** Duration of verification in ms */
  durationMs?: number;
}
