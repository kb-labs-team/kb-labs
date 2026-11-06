import type { ICache } from '@kb-labs/core-platform'
import { createErrorEnvelope, ErrorEnvelopeError } from '@kb-labs/core-platform/error-envelope'

export function requireWorkflowProjectId(projectId: string | undefined): string {
  if (!projectId?.trim()) {
    throw new ErrorEnvelopeError(createErrorEnvelope('KB_RUNTIME_WORKFLOW_PROJECT_ID_REQUIRED'))
  }
  return projectId
}

export function workflowProjectCacheKey(projectId: string, key: string): string {
  return `workflow:project:${requireWorkflowProjectId(projectId)}:${key}`
}

/** Restricts every workflow-engine cache operation to its registered project. */
export class ProjectScopedCache implements ICache {
  constructor(private readonly cache: ICache, private readonly projectId: string) {
    requireWorkflowProjectId(projectId)
  }

  get<T>(key: string): Promise<T | null> {
    return this.cache.get<T>(this.key(key))
  }

  set<T>(key: string, value: T, ttl?: number): Promise<void> {
    return this.cache.set(this.key(key), value, ttl)
  }

  delete(key: string): Promise<void> {
    return this.cache.delete(this.key(key))
  }

  clear(pattern?: string): Promise<void> {
    return this.cache.clear(pattern === undefined ? `${workflowProjectCacheKey(this.projectId, '')}*` : this.key(pattern))
  }

  zadd(key: string, score: number, member: string): Promise<void> {
    return this.cache.zadd(this.key(key), score, member)
  }

  zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    return this.cache.zrangebyscore(this.key(key), min, max)
  }

  zrem(key: string, member: string): Promise<void> {
    return this.cache.zrem(this.key(key), member)
  }

  setIfNotExists<T>(key: string, value: T, ttl?: number): Promise<boolean> {
    return this.cache.setIfNotExists(this.key(key), value, ttl)
  }

  private key(key: string): string {
    return workflowProjectCacheKey(this.projectId, key)
  }
}
