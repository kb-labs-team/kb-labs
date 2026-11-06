import type { RetryPolicy } from '@kb-labs/workflow-contracts'

const DEFAULT_INITIAL_INTERVAL_MS = 1000

export interface RetryDecision {
  shouldRetry: boolean
  nextDelayMs?: number
}

export function calculateBackoff(
  attempt: number,
  policy?: RetryPolicy,
): number {
  if (!policy) {
    return 0
  }

  const base = policy.initialIntervalMs ?? DEFAULT_INITIAL_INTERVAL_MS
  const backoff =
    policy.backoff === 'lin'
      ? base * (attempt + 1)
      : base * Math.pow(2, attempt)

  if (policy.maxIntervalMs) {
    return Math.min(backoff, policy.maxIntervalMs)
  }
  return backoff
}

export function shouldRetry(
  attempt: number,
  policy?: RetryPolicy,
): RetryDecision {
  if (!policy) {
    return { shouldRetry: false }
  }
  if (attempt >= policy.max) {
    return { shouldRetry: false }
  }

  return {
    shouldRetry: true,
    nextDelayMs: calculateBackoff(attempt, policy),
  }
}





