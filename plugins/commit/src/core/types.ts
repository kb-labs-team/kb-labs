/**
 * Core types for KB Labs Commit Plugin
 *
 * Note: Zod schemas and inferred types are in @kb-labs/commit/contracts.
 * This file contains internal types used within commit-core.
 */

// Re-export types from contracts for convenience
export type {
  ConventionalType,
  ReleaseHint,
  GitStatus,
  FileSummary,
  CommitGroup,
  CommitPlan,
  GitStatusSnapshot,
  ApplyResult,
  PushResult,
} from '../contracts/index.js';

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Options for generating a commit plan
 *
 * Note: Debug logging and LLM access are handled via SDK hooks (useLogger, useLLM),
 * which can be called anywhere without passing through arguments.
 */
export interface GenerateOptions {
  /** Working directory (repo root) */
  cwd: string;
  /** Optional scope pattern to filter files */
  scope?: string;
  /** Recent commits for style reference */
  recentCommits?: string[];
  /** Plugin configuration (from kb.config.json + env) */
  config?: import('../contracts/index.js').CommitPluginConfig; // eslint-disable-line @typescript-eslint/consistent-type-imports
  /** Progress callback for UI updates (updates spinner text) */
  onProgress?: (message: string) => void;
  /** Human-facing output routed by the CLI or REST execution host. */
  onOutput: (message: string) => void;
  /** Pause progress spinner before interactive prompts */
  onPauseProgress?: () => void;
  /** Resume progress spinner after interactive prompts */
  onResumeProgress?: () => void;
  /** LLM completion function (optional - can be undefined if LLM disabled) */
  llmComplete?: LLMCompleteFunction;
  /** Allow committing files with detected secrets (requires manual confirmation) */
  allowSecrets?: boolean;
  /** Auto-confirm all prompts (--yes flag for non-interactive mode) */
  autoConfirm?: boolean;
}

/**
 * Options for applying a commit plan
 */
export interface ApplyOptions {
  /** Force apply even if working tree changed */
  force?: boolean;
  /** Scope pattern to filter files (e.g., '@kb-labs/workflow', 'packages/core/**') */
  scope?: string;
}

/**
 * Options for pushing commits
 */
export interface PushOptions {
  /** Force push (dangerous!) */
  force?: boolean;
  /** Remote name (default: origin) */
  remote?: string;
  /** Scope pattern to filter files (e.g., '@kb-labs/workflow', 'packages/core/**') */
  scope?: string;
}

/**
 * LLM completion function signature
 */
export type LLMCompleteFunction = (
  prompt: string,
  options?: {
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
  }
) => Promise<{
  content: string;
  tokensUsed?: number;
}>;

/**
 * Result of git status check with staleness info
 */
export interface GitStatusWithStaleness {
  status: import('../contracts/index.js').GitStatus; // eslint-disable-line @typescript-eslint/consistent-type-imports
  summaries: import('../contracts/index.js').FileSummary[]; // eslint-disable-line @typescript-eslint/consistent-type-imports
  hash: string;
}
