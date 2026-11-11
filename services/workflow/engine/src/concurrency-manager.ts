import { CONCURRENCY_TTL_ENV } from '@kb-labs/workflow-constants'
import type { ConcurrencyGroup } from '@kb-labs/workflow-contracts'
import type { ICache } from '@kb-labs/core-platform'
import type { EngineLogger } from './types'

const DEFAULT_TTL_MS = 1000 * 60 * 30 // 30 minutes

function resolveTtlMs(explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) {
    return explicit
  }
  const envValue = process.env[CONCURRENCY_TTL_ENV]
  const parsed = envValue ? Number(envValue) : undefined
  if (parsed && Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  return DEFAULT_TTL_MS
}

export interface AcquireOptions {
  ttlMs?: number
}

export class ConcurrencyManager {
  private readonly cache: ICache
  private readonly ttlMs: number

  constructor(
    cache: ICache,
    private readonly logger: EngineLogger,
    options: AcquireOptions = {},
  ) {
    this.cache = cache
    this.ttlMs = resolveTtlMs(options.ttlMs)
  }

  async acquire(
    group: ConcurrencyGroup,
    runId: string,
    options: AcquireOptions = {},
  ): Promise<boolean> {
    const ttl = resolveTtlMs(options.ttlMs ?? this.ttlMs)
    const key = `kb:concurrency:${group}`
    const acquired = await this.cache.setIfNotExists(key, runId, ttl)

    this.logger.debug('Concurrency acquire attempt', {
      group,
      runId,
      acquired,
    })
    return acquired
  }

  async release(group: ConcurrencyGroup, runId: string): Promise<void> {
    const key = `kb:concurrency:${group}`
    const current = await this.cache.get<string>(key)
    if (current === runId) {
      await this.cache.delete(key)
      this.logger.debug('Concurrency lock released', { group, runId })
    }
  }

  async getActiveRun(group: ConcurrencyGroup): Promise<string | null> {
    const key = `kb:concurrency:${group}`
    return this.cache.get<string>(key)
  }
}


