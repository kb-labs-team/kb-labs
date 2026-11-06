import { createHash } from 'node:crypto'

export function workflowDeadLetterCacheKey(runId: string, jobId: string): string {
  const identity = createHash('sha256').update(JSON.stringify([runId, jobId])).digest('hex').slice(0, 32)
  return `workflow:dlq:${identity}`
}
