/**
 * @module @kb-labs/core-contracts/retry
 *
 * Three retry levels (CC3):
 *
 * Level 1 (transport) — transparent, in HTTP/WS transport layer.
 *   Retries on 503, network errors. Client doesn't know.
 *
 * Level 2 (execution) — configurable in ExecutionConfig.retry.
 *   Wraps backend.execute() with retry + backoff.
 *   Emits execution:retry events between attempts.
 *
 * Level 3 (checkpoint) — opt-in, implemented by handler.
 *   Handler saves progress via ctx.checkpoint, resumes on retry.
 */

/** Canonical failure source. */
export type FailureSource = 'execution' | 'command' | 'transport' | 'workflow';

/** Canonical failure taxonomy shared by execution, CLI and workflow hosts. */
export type FailureKind =
  | 'command'
  | 'exit'
  | 'stalled'
  | 'network'
  | 'timeout'
  | 'rate_limit'
  | 'server'
  | 'validation'
  | 'configuration'
  | 'authentication'
  | 'authorization'
  | 'not_found'
  | 'cancelled'
  | 'infrastructure'
  | 'unknown';

/** Safety of repeating an operation after a failure. */
export type RetrySafety = 'safe' | 'requires_idempotency' | 'never';

/** Structured failure information supplied by a plugin or execution layer. */
export interface FailureInfo {
  message: string;
  code: string;
  kind?: FailureKind;
  source?: FailureSource;
  details?: Record<string, unknown>;
  retryAfterMs?: number;
  retryable?: boolean;
  dependency?: string;
  exitCode?: number;
}

/** Classifier output used by all retry policies. */
export interface ClassifiedFailure extends FailureInfo {
  kind: FailureKind;
  source: FailureSource;
  transient: boolean;
  retrySafety: RetrySafety;
  phase?: 'dispatch' | 'running' | 'response';
}

/** Input context that prevents ambiguous transport failures from being retried blindly. */
export interface FailureClassificationContext {
  source?: FailureSource;
  phase?: 'dispatch' | 'running' | 'response';
  idempotent?: boolean;
}

/** Backward-compatible retry input. Prefer ClassifiedFailure for new code. */
export interface RetryableError {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * Level 2: Execution retry policy.
 * Determines whether to retry and with what delay.
 */
export interface IRetryPolicy {
  /** Maximum number of attempts (including first try). */
  maxAttempts: number;
  /** Whether this error should be retried. */
  shouldRetry(error: RetryableError, attempt: number): boolean;
  /** Delay in ms before next attempt (for backoff). */
  getDelay(attempt: number): number;
}

/** Failure kinds allowed by a retry policy. */
export type RetryableFailureKind = FailureKind;

/** Shared retry configuration. maxAttempts includes the initial attempt. */
export interface RetryPolicyConfig {
  maxAttempts: number;
  retryOn: RetryableFailureKind[];
  neverRetryOn?: FailureKind[];
  initialDelayMs: number;
  backoff: 'fixed' | 'linear' | 'exponential';
  multiplier?: number;
  maxDelayMs: number;
  jitter?: number;
  respectRetryAfter?: boolean;
  requireIdempotencyForUnsafeFailures?: boolean;
}

export interface RetryDecision {
  retry: boolean;
  reason: 'retryable' | 'attempts_exhausted' | 'policy_denied' | 'not_idempotent' | 'unsafe_phase';
  delayMs: number;
}

/**
 * Level 3: Checkpoint interface for handler-level resume.
 * Available via ctx.checkpoint in handler execution context.
 */
export interface ICheckpointContext {
  /** Get last saved checkpoint data. */
  getCheckpoint<T = unknown>(): Promise<T | null>;
  /** Save checkpoint (survives retries, cleared on success). */
  saveCheckpoint<T = unknown>(data: T): Promise<void>;
  /** Clear checkpoint (call on successful completion). */
  clearCheckpoint(): Promise<void>;
}

/**
 * Retry configuration for ExecutionConfig.
 */
export interface ExecutionRetryConfig {
  /** Maximum attempts (including first try). @default 1 (no retry) */
  maxAttempts?: number;
  /** Initial delay between retries in ms. @default 1000 */
  initialDelayMs?: number;
  /** Backoff multiplier. @default 2 */
  backoffMultiplier?: number;
  /** Maximum delay cap in ms. @default 30000 */
  maxDelayMs?: number;
  /** Only retry errors with retryable=true. @default true */
  onlyRetryable?: boolean;
}
