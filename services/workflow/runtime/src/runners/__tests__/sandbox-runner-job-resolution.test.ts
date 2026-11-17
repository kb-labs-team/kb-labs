import { describe, expect, it, vi } from 'vitest'
import type { IEntityRegistry } from '@kb-labs/plugin-contracts'
import type { ExecutionBackend } from '@kb-labs/plugin-execution'
import { SandboxRunner } from '../sandbox-runner.js'
import type { StepExecutionRequest } from '../../types.js'

describe('SandboxRunner manifest job resolution', () => {
  // case: S-301.1
  it('resolves explicit plugin job references against manifest.jobs.handlers', async () => {
    const backendExecute = vi.fn().mockResolvedValue({ ok: true, data: { ok: true } })
    const runner = new SandboxRunner({
      backend: { execute: backendExecute } as unknown as ExecutionBackend,
      cliApi: {
        snapshot: () => ({ manifests: [{
          pluginId: '@kb-labs/steward:custom',
          pluginRoot: '/plugins/steward',
          manifest: {
            version: '2.120.1',
            workflows: { handlers: [{ id: 'daily-review', handler: './workflows/daily-review.js#default', permissions: { platform: { logger: { methods: ['error'] } } } }] },
            jobs: { handlers: [{ id: 'daily-review', handler: './jobs/daily-review.js#default', permissions: { platform: { storage: { paths: ['steward/'] } } } }] },
          },
        }] }),
      } as unknown as IEntityRegistry,
    })
    const request: StepExecutionRequest = {
      spec: { name: 'Steward daily review', uses: 'plugin:@kb-labs/steward:custom/job/daily-review', with: { requestedBy: 'caller' } },
      context: {
        runId: 'run-s301', jobId: 'run-s301:main', stepId: 'execute', attempt: 1,
        env: {}, secrets: {},
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      workspace: '/project',
    }

    const result = await runner.execute(request)

    expect(result.status).toBe('success')
    expect(backendExecute).toHaveBeenCalledWith(expect.objectContaining({
      pluginRoot: '/plugins/steward',
      handlerRef: './jobs/daily-review.js#default',
      input: { requestedBy: 'caller', jobId: 'daily-review', runCount: 1, executedAt: expect.any(Date) },
      descriptor: expect.objectContaining({ permissions: {
        platform: { storage: { paths: ['steward/'] } },
      } }),
    }), expect.anything())
  })
})
