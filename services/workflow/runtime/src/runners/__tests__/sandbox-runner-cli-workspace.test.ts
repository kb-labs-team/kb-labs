import { describe, expect, it, vi } from 'vitest'
import type { IEntityRegistry } from '@kb-labs/plugin-contracts'
import type { ExecutionBackend } from '@kb-labs/plugin-execution'
import { SandboxRunner } from '../sandbox-runner.js'
import type { StepExecutionRequest } from '../../types.js'

describe('SandboxRunner — CLI command worktree routing', () => {
  function createRunner() {
    const execute = vi.fn<ExecutionBackend['execute']>()
    const backend = {
      execute: execute.mockResolvedValue({
        ok: true, data: { ok: true, result: { cases: [] } }, executionTimeMs: 1,
      } as Awaited<ReturnType<ExecutionBackend['execute']>>),
    } as ExecutionBackend
    const runner = new SandboxRunner({
      backend,
      cliApi: {
        snapshot: () => ({ manifests: [{
          pluginId: '@kb-labs/qa', pluginRoot: '/plugins/qa',
          manifest: {
            version: '1.0.0', configSection: 'qa',
            cli: { commands: [{ path: 'qa cases list', handler: './cli/list.js#default' }] },
          },
        }] }),
      } as unknown as IEntityRegistry,
      workspaceRoot: '/runner/workspace',
    })
    return { execute, runner }
  }

  function makeRequest(
    input: StepExecutionRequest['spec']['with'],
    env: Record<string, string>,
  ): StepExecutionRequest {
    return {
      spec: { name: 'Run plugin CLI command', uses: 'command:qa cases list', with: input },
      context: {
        runId: 'run-1', jobId: 'job-1', stepId: 'cli-step', attempt: 1,
        env, secrets: {},
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      workspace: '/platform/workspace',
    }
  }

  // case: S-321.1
  it('uses the worktree for the command input and handler context', async () => {
    const { runner, execute } = createRunner()
    const env = {
      KB_PLATFORM_ROOT: '/platform/workspace',
      KB_WORKSPACE_ROOT: '/task/worktree',
    }

    const plainFlags = await runner.execute(makeRequest({ json: true }, env))
    const cliInput = await runner.execute(makeRequest({
      argv: ['argument'], flags: { json: true },
    }, env))

    expect(plainFlags.status).toBe('success')
    expect(cliInput.status).toBe('success')
    expect(execute.mock.calls.map(([request]) => request.workspace)).toEqual([
      { type: 'local', cwd: '/task/worktree' },
      { type: 'local', cwd: '/task/worktree' },
    ])
    expect(execute.mock.calls.map(([request]) => request.input)).toEqual([
      { argv: [], flags: { json: true }, cwd: '/task/worktree' },
      { argv: ['argument'], flags: { json: true }, cwd: '/task/worktree' },
    ])
    expect(execute.mock.calls[0]?.[0].descriptor.configSection).toBe('qa')
  })

  // case: S-321.2
  it('uses the supplied workspace when no task worktree is supplied', async () => {
    const { runner, execute } = createRunner()

    await runner.execute(makeRequest({ json: true }, {}))

    const request = execute.mock.calls[0]?.[0]
    expect(request?.workspace).toEqual({ type: 'local', cwd: '/platform/workspace' })
    expect(request?.input).toMatchObject({ cwd: '/platform/workspace' })
  })

  it('uses the runner default for an empty workspace and preserves an explicit CLI input cwd', async () => {
    const { runner, execute } = createRunner()

    await runner.execute({ ...makeRequest({ json: true }, {}), workspace: '' })
    await runner.execute(makeRequest({
      argv: [], flags: { json: true }, cwd: '/explicit/path',
    }, { KB_WORKSPACE_ROOT: '/task/worktree' }))

    const defaultWorkspaceRequest = execute.mock.calls[0]?.[0]
    expect(defaultWorkspaceRequest?.workspace).toBeUndefined()
    expect(defaultWorkspaceRequest?.input).toMatchObject({ cwd: '/runner/workspace' })
    const explicitInputRequest = execute.mock.calls[1]?.[0]
    expect(explicitInputRequest?.workspace).toEqual({ type: 'local', cwd: '/task/worktree' })
    expect(explicitInputRequest?.input).toMatchObject({ cwd: '/explicit/path' })
  })
})
