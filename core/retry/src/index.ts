import type {
  ClassifiedFailure,
  FailureClassificationContext,
  FailureInfo,
  FailureKind,
  FailureSource,
  RetryDecision,
  RetryPolicyConfig,
} from '@kb-labs/core-contracts';

export type {
  ClassifiedFailure,
  FailureClassificationContext,
  FailureInfo,
  FailureKind,
  FailureSource,
  RetryDecision,
  RetryPolicyConfig,
};

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED']);
const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function getStatus(value: Record<string, unknown> | undefined): number | undefined {
  const response = asRecord(value?.response);
  const status = value?.status ?? value?.statusCode ?? response?.status;
  return typeof status === 'number' ? status : undefined;
}

function getCode(value: Record<string, unknown> | undefined): string | undefined {
  return typeof value?.code === 'string' ? value.code : undefined;
}

function makeFailure(
  input: unknown,
  kind: FailureKind,
  source: FailureSource,
  context: FailureClassificationContext,
  code?: string,
  transient = false,
  retrySafety: ClassifiedFailure['retrySafety'] = 'never',
): ClassifiedFailure {
  const record = asRecord(input);
  const message = input instanceof Error ? input.message : String(record?.message ?? input ?? 'Unknown failure');
  const retryAfterMs = typeof record?.retryAfterMs === 'number' ? record.retryAfterMs : undefined;
  return {
    message,
    code: code ?? getCode(record) ?? 'UNKNOWN_ERROR',
    kind,
    source,
    transient,
    retrySafety,
    phase: context.phase,
    retryAfterMs,
    retryable: typeof record?.retryable === 'boolean' ? record.retryable : undefined,
    dependency: typeof record?.dependency === 'string' ? record.dependency : undefined,
    exitCode: typeof record?.exitCode === 'number' ? record.exitCode : undefined,
    details: asRecord(record?.details),
  };
}

/** Classify structured errors without using human-readable output as a status signal. */
export function classifyFailure(input: unknown, context: FailureClassificationContext = {}): ClassifiedFailure {
  const record = asRecord(input);
  const source = context.source ?? (record?.source as FailureSource | undefined) ?? 'execution';
  if (record?.retryAfterMs !== undefined && (typeof record.retryAfterMs !== 'number' || !Number.isFinite(record.retryAfterMs) || record.retryAfterMs < 0)) {
    return makeFailure({ message: 'Invalid retry-after delay', retryable: false }, 'validation', source, context, 'INVALID_RETRY_AFTER');
  }
  const explicitKind = record?.kind as FailureKind | undefined;
  const explicitCode = getCode(record);
  const status = getStatus(record);
  const code = explicitCode?.toUpperCase();

  if (explicitKind && ['command', 'exit', 'stalled', 'network', 'timeout', 'rate_limit', 'server', 'validation', 'configuration', 'authentication', 'authorization', 'not_found', 'cancelled', 'infrastructure', 'unknown'].includes(explicitKind)) {
    const transient = ['network', 'timeout', 'rate_limit', 'server'].includes(explicitKind);
    const safe = record?.retryable === true || (explicitKind === 'network' && (code === 'ECONNREFUSED' || code === 'NETWORK_UNAVAILABLE'));
    return makeFailure(input, explicitKind, source, context, code, transient, safe ? 'safe' : transient ? 'requires_idempotency' : 'never');
  }

  if (code && NETWORK_CODES.has(code)) {
    return makeFailure(input, code === 'ETIMEDOUT' ? 'timeout' : 'network', source, context, code, true, context.phase === 'dispatch' ? 'safe' : 'requires_idempotency');
  }

  if (status !== undefined) {
    if (status === 429) {return makeFailure(input, 'rate_limit', source, context, 'HTTP_429', true, 'safe');}
    if (status >= 500 || status === 408 || status === 425) {return makeFailure(input, status === 408 ? 'timeout' : 'server', source, context, `HTTP_${status}`, true, 'requires_idempotency');}
    if (status >= 400) {return makeFailure(input, 'validation', source, context, `HTTP_${status}`, false, 'never');}
  }

  const message = input instanceof Error ? input.message.toLowerCase() : String(record?.message ?? input ?? '').toLowerCase();
  const name = typeof record?.name === 'string' ? record.name.toLowerCase() : '';
  if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests') || message.includes('quota exceeded') || name.includes('ratelimit')) {
    return makeFailure(input, 'rate_limit', source, context, 'RATE_LIMIT', true, 'safe');
  }
  if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504') || message.includes('service unavailable') || message.includes('bad gateway')) {
    return makeFailure(input, 'server', source, context, 'SERVER_ERROR', true, 'requires_idempotency');
  }
  if (message.includes('400') || message.includes('401') || message.includes('403') || message.includes('404') || message.includes('bad request') || message.includes('unauthorized') || message.includes('forbidden') || message.includes('not found')) {
    return makeFailure(input, 'validation', source, context, 'CLIENT_ERROR');
  }
  if (message.includes('timeout') || message.includes('timed out') || message.includes('etimedout') || message.includes('deadline exceeded') || name.includes('timeout') || code?.includes('TIMEOUT')) {return makeFailure(input, 'timeout', source, context, 'TIMEOUT', true, 'requires_idempotency');}
  if (message.includes('unauthorized') || message.includes('forbidden')) {return makeFailure(input, 'authentication', source, context, 'AUTHENTICATION_FAILED');}
  if (message.includes('econn') || message.includes('enotfound') || message.includes('network') || message.includes('socket') || message.includes('dns') || message.includes('host not connected') || name.includes('fetch') || name.includes('network')) {return makeFailure(input, 'network', source, context, 'NETWORK_ERROR', true, 'requires_idempotency');}

  return makeFailure(input, source === 'command' ? 'command' : 'unknown', source, context, code ?? 'UNKNOWN_ERROR');
}

export const DEFAULT_TRANSIENT_RETRY_POLICY: RetryPolicyConfig = {
  maxAttempts: 2,
  retryOn: ['network', 'rate_limit', 'server'],
  initialDelayMs: 1000,
  backoff: 'exponential',
  multiplier: 2,
  maxDelayMs: 30_000,
  jitter: 0.1,
  respectRetryAfter: true,
  requireIdempotencyForUnsafeFailures: true,
};

/** Decide retry without allowing unknown failures or log output to trigger retries. */
export function decideRetry(input: {
  failure: ClassifiedFailure;
  attempt: number;
  policy?: Partial<RetryPolicyConfig>;
  idempotent?: boolean;
}): RetryDecision {
  const policy = { ...DEFAULT_TRANSIENT_RETRY_POLICY, ...input.policy };
  const { failure, attempt } = input;
  if (failure.retryable === false) {return { retry: false, reason: 'policy_denied', delayMs: 0 };}
  if (attempt + 1 >= policy.maxAttempts) {return { retry: false, reason: 'attempts_exhausted', delayMs: 0 };}
  if (policy.neverRetryOn?.includes(failure.kind) || !policy.retryOn.includes(failure.kind)) {
    return { retry: false, reason: 'policy_denied', delayMs: 0 };
  }
  if (policy.requireIdempotencyForUnsafeFailures && failure.retrySafety === 'requires_idempotency' && !input.idempotent) {
    return { retry: false, reason: 'not_idempotent', delayMs: 0 };
  }
  const base = policy.initialDelayMs * (policy.backoff === 'linear' ? attempt + 1 : policy.backoff === 'fixed' ? 1 : Math.pow(policy.multiplier ?? 2, attempt));
  const capped = Math.min(base, policy.maxDelayMs);
  const jitter = policy.jitter ? capped * policy.jitter * Math.random() : 0;
  const delayMs = policy.respectRetryAfter && failure.retryAfterMs !== undefined
    ? failure.retryAfterMs
    : Math.floor(capped + jitter);
  return { retry: true, reason: 'retryable', delayMs };
}
