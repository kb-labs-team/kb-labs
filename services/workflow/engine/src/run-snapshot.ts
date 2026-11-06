import type { WorkflowRun } from '@kb-labs/workflow-contracts'
import type { ICache } from '@kb-labs/core-platform'
import type { EngineLogger } from './types'

export interface RunSnapshot {
  runId: string
  run: WorkflowRun
  stepOutputs: Record<string, Record<string, unknown>>
  env: Record<string, string>
  refs?: {
    workspaceSnapshotId?: string
    environmentSnapshotId?: string
  }
  createdAt: string
  version: string
}

const SNAPSHOT_VERSION = '1.0.0'

export class RunSnapshotStorage {
  constructor(
    private readonly cache: ICache,
    private readonly logger: EngineLogger,
  ) {}

  private getSnapshotKey(runId: string): string {
    return `workflow:snapshot:${runId}`
  }

  async createSnapshot(
    run: WorkflowRun,
    stepOutputs: Record<string, Record<string, unknown>>,
    env: Record<string, string>,
    refs?: RunSnapshot['refs'],
  ): Promise<RunSnapshot> {
    const snapshot: RunSnapshot = {
      runId: run.id,
      run,
      stepOutputs,
      env,
      refs,
      createdAt: new Date().toISOString(),
      version: SNAPSHOT_VERSION,
    }

    const key = this.getSnapshotKey(run.id)
    // Store snapshot with 7 days TTL (in milliseconds)
    await this.cache.set(
      key,
      JSON.stringify(snapshot),
      7 * 24 * 60 * 60 * 1000, // 7 days in ms
    )

    this.logger.info('Snapshot created', { runId: run.id })
    return snapshot
  }

  async getSnapshot(runId: string): Promise<RunSnapshot | null> {
    const key = this.getSnapshotKey(runId)
    const stored = await this.cache.get<string>(key)
    if (!stored) {
      return null
    }

    try {
      const snapshot = JSON.parse(stored) as RunSnapshot
      // Validate version
      if (snapshot.version !== SNAPSHOT_VERSION) {
        this.logger.warn('Snapshot version mismatch', {
          runId,
          expected: SNAPSHOT_VERSION,
          actual: snapshot.version,
        })
        // Try to load anyway, but log warning
      }
      return snapshot
    } catch (error) {
      this.logger.error('Failed to parse snapshot', error instanceof Error ? error : undefined, {
        runId,
      })
      return null
    }
  }

  async deleteSnapshot(runId: string): Promise<void> {
    const key = this.getSnapshotKey(runId)
    await this.cache.delete(key)
    this.logger.debug('Snapshot deleted', { runId })
  }
}
