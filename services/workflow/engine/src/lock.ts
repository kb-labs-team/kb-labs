import { randomUUID } from 'node:crypto'
import type { ICache } from '@kb-labs/core-platform'

/**
 * How long a short-lived write lock is held before it auto-expires. Callers
 * use this to guard a single read-modify-write cycle (a few milliseconds in
 * the normal case), not a whole run's execution — contrast with
 * `ConcurrencyManager`'s 30-minute run-scoped lock. Generous on purpose: a
 * slow cache backend or a GC pause mid-write should not cause a spurious
 * "lost my own lock" release race (see `withLock`'s docblock).
 */
const LOCK_TTL_MS = 5_000

/** Give up acquiring a lock after this long and surface a clear error rather
 * than hang the caller forever — a lock stuck this long past its own TTL
 * means something is already broken (e.g. every holder in this window
 * crashed without letting the TTL expire naturally, which shouldn't happen
 * since expiry doesn't require cooperation from the crashed holder). */
const LOCK_ACQUIRE_TIMEOUT_MS = 15_000
const LOCK_RETRY_BASE_MS = 20
const LOCK_RETRY_MAX_MS = 250

export class LockAcquireTimeoutError extends Error {
  constructor(public readonly lockKey: string) {
    super(`Timed out waiting for lock: ${lockKey}`)
    this.name = 'LockAcquireTimeoutError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Same lock idiom as `ConcurrencyManager.acquire/release` (`setIfNotExists`
 * as a TTL-bounded mutex, a random token as the value so release only ever
 * removes a lock this call actually holds) — reused here at a much shorter
 * TTL for a much shorter critical section. Retries acquisition with
 * jittered backoff instead of ConcurrencyManager's single attempt, since
 * callers here need "wait your turn", not "fail fast if busy".
 *
 * The release step (`get` then conditional `delete`) is not itself atomic:
 * in principle another holder could acquire between our `get` and our
 * `delete` if our own lock had already expired. That requires our own
 * critical section to have overrun `LOCK_TTL_MS` (a few milliseconds of
 * budget) *and* a third party to land in that exact gap — a compound,
 * low-probability race, categorically narrower than the unguarded
 * read-modify-write this replaces (which lost updates on every ordinary
 * concurrent write, deterministically). Accepted rather than solved with a
 * heavier primitive; revisit only if it's ever observed in practice.
 */
export async function withLock<T>(cache: ICache, lockKey: string, fn: () => Promise<T>): Promise<T> {
  const token = randomUUID()
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS
  let delay = LOCK_RETRY_BASE_MS
  for (;;) {
    const acquired = await cache.setIfNotExists(lockKey, token, LOCK_TTL_MS)
    if (acquired) {
      break
    }
    if (Date.now() >= deadline) {
      throw new LockAcquireTimeoutError(lockKey)
    }
    await sleep(delay + Math.random() * delay)
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }

  try {
    return await fn()
  } finally {
    const current = await cache.get<string>(lockKey)
    if (current === token) {
      await cache.delete(lockKey)
    }
  }
}
