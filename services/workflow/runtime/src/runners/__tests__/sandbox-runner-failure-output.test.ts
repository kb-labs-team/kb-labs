import { describe, expect, it, vi } from 'vitest'
import type { IEntityRegistry } from '@kb-labs/plugin-contracts';
import type { ExecutionBackend } from '@kb-labs/plugin-execution'
import { createErrorEnvelope } from '@kb-labs/core-platform'
import { SandboxRunner } from '../sandbox-runner.js'
import type { StepExecutionRequest } from '../../types.js'

describe('SandboxRunner failed shell output', () => {
  async function executeFailedShell() {
    const backend = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          ok: false,
          exitCode: 23,
          stdout: 'journey-failure-diagnostic\n',
          stderr: '',
        },
      }),
    } as unknown as ExecutionBackend
    const runner = new SandboxRunner({
      backend,
      cliApi: { resolve: vi.fn(), list: vi.fn() } as unknown as IEntityRegistry,
      workspaceRoot: '/project',
    })
    const request: StepExecutionRequest = {
      spec: { name: 'Deliberate failure', uses: 'builtin:shell', with: { command: 'echo failure' } },
      context: {
        runId: 'run-1',
        jobId: 'run-1:smoke',
        stepId: 'deliberate-failure',
        attempt: 1,
        env: {},
        secrets: {},
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      workspace: '/project',
    }

    return runner.execute(request)
  }

  // case: S-029.2
  it('includes captured command output in the failed step diagnostic', async () => {
    const result = await executeFailedShell()
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') { throw new Error('expected a failed step result') }
    expect(result.error.message).toContain('journey-failure-diagnostic')
  })

  // case: S-029.3
  it('retains failed command output for workflow logs', async () => {
    const result = await executeFailedShell()
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') { throw new Error('expected a failed step result') }
    expect(result.outputs).toEqual({
      stdout: 'journey-failure-diagnostic\n',
      stderr: '',
      exitCode: 23,
    })
  })
})

describe('SandboxRunner plugin failure diagnostics', () => {
  // case: S-243.5
  it('preserves the catalogue timeout code and hint on a failed step', async () => {
    const timeout = createErrorEnvelope('KB_RUNTIME_TIMEOUT', { details: { timeoutMs: '25' } });
    const runner = new SandboxRunner({
      backend: {
        execute: vi.fn().mockResolvedValue({ ok: false, error: timeout, executionTimeMs: 25 }),
      } as unknown as ExecutionBackend,
      cliApi: { snapshot: () => ({ manifests: [] }) } as unknown as IEntityRegistry,
    });

    const result = await runner.execute({
      spec: { name: 'Timed out shell', uses: 'builtin:shell', timeoutMs: 25, with: { command: 'sleep 30' } },
      context: {
        runId: 'run-timeout', jobId: 'run-timeout:job', stepId: 'step-timeout', attempt: 0,
        env: {}, secrets: {},
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') { throw new Error('expected a failed step result'); }
    expect(result.error).toMatchObject({ code: timeout.code, message: timeout.message, hint: timeout.hint });
  });

  // case: S-203.6
  it('correlates plugin failure logs without exposing handler stacks in step errors', async () => {
    const backend = {
      execute: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: 'KB_RUNTIME_UNEXPECTED',
          message: 'An unexpected error occurred.',
          stack: 'Error: private handler diagnostic\n    at handler.js:1:1',
        },
        executionTimeMs: 1,
      }),
    } as unknown as ExecutionBackend
    const logError = vi.fn()
    const runner = new SandboxRunner({
      backend,
      cliApi: {
        snapshot: () => ({ manifests: [{
          pluginId: '@kb-labs/test-plugin',
          pluginRoot: '/plugin',
          manifest: {
            version: '1.0.0',
            workflows: { handlers: [{ id: 'run', handler: './dist/run.js' }] },
          },
        }] }),
      } as unknown as IEntityRegistry,
      workspaceRoot: '/project',
    })

    const result = await runner.execute({
      spec: { name: 'Plugin failure', uses: 'plugin:@kb-labs/test-plugin/run', with: {} },
      context: {
        runId: 'run-1',
        jobId: 'run-1:work',
        stepId: 'plugin-failure',
        attempt: 1,
        env: {},
        secrets: {},
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError },
      },
      workspace: '/project',
    })

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') { throw new Error('expected a failed step result') }
    expect(result.error).not.toHaveProperty('stack')
    expect(logError).toHaveBeenCalledWith('Plugin handler failed', expect.objectContaining({
      correlationId: expect.any(String),
    }))
  })
})
