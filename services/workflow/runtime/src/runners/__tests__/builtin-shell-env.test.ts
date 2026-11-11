import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SandboxRunner } from '../sandbox-runner.js'
import type { StepExecutionRequest } from '../../types.js'

/**
 * Regression test: builtin:shell steps must use context.env.KB_WORKSPACE_ROOT (worktree)
 * for KB_WORKSPACE_ROOT, not request.workspace (platform root).
 *
 * Bug: resolveBuiltinShell(spec, request.workspace) passed the platform root as KB_WORKSPACE_ROOT.
 * Fix: pass request.context.env['KB_WORKSPACE_ROOT'] ?? request.workspace instead.
 *
 * Without the fix, scripts that do `cd "${KB_WORKSPACE_ROOT}"` would cd into the main
 * workspace instead of the provisioned worktree, causing git/file operations to run in
 * the wrong directory.
 */
describe('SandboxRunner — builtin:shell KB_WORKSPACE_ROOT routing', () => {
  let capturedInput: Record<string, unknown> | undefined

  const mockBackend = {
    execute: vi.fn().mockImplementation(async (req: { input: Record<string, unknown> }) => {
      capturedInput = req.input as Record<string, unknown>
      return { ok: true, outputs: {}, stdout: '', stderr: '', exitCode: 0 }
    }),
  }

  const mockCliApi = {
    resolve: vi.fn(),
    list: vi.fn(),
  }

  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  beforeEach(() => {
    capturedInput = undefined
    vi.clearAllMocks()
  })

  function makeRequest(overrides?: Partial<StepExecutionRequest>): StepExecutionRequest {
    return {
      spec: {
        name: 'shell-step',
        uses: 'builtin:shell',
        with: { command: 'echo test', env: { DECLARED_VALUE: 'step' } },
      },
      context: {
        runId: 'run-1',
        jobId: 'job-1',
        stepId: 'step-1',
        attempt: 1,
        env: {
          KB_PLATFORM_ROOT: '/main/workspace',
          KB_WORKSPACE_ROOT: '/private/tmp/kb-worktrees/wt_abc123',
          DECLARED_VALUE: 'workflow',
        },
        secrets: {},
        logger: mockLogger,
      },
      workspace: '/main/workspace',
      ...overrides,
    }
  }

  it('uses context.env.KB_WORKSPACE_ROOT (worktree) not request.workspace (platform root)', async () => {
    const runner = new SandboxRunner({

      backend: mockBackend as any,

      cliApi: mockCliApi as any,
      workspaceRoot: '/main/workspace',
      platformRoot: '/opt/kb-platform',
    })

    await runner.execute(makeRequest())

    expect(mockBackend.execute).toHaveBeenCalledOnce()
    const env = capturedInput?.['env'] as Record<string, string> | undefined
    // Worktree path must be forwarded to the shell step env
    expect(env?.['KB_WORKSPACE_ROOT']).toBe('/private/tmp/kb-worktrees/wt_abc123')
    // Platform root is separate — always the main workspace
    expect(env?.['KB_PLATFORM_ROOT']).toBe('/opt/kb-platform')
    expect(env?.['DECLARED_VALUE']).toBe('workflow')
  })

  it('falls back to request.workspace when context.env has no KB_WORKSPACE_ROOT', async () => {
    const runner = new SandboxRunner({

      backend: mockBackend as any,

      cliApi: mockCliApi as any,
      workspaceRoot: '/main/workspace',
    })

    await runner.execute(
      makeRequest({
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          env: { KB_PLATFORM_ROOT: '/main/workspace' }, // no KB_WORKSPACE_ROOT
          secrets: {},
          logger: mockLogger,
        },
        workspace: '/main/workspace',
      }),
    )

    expect(mockBackend.execute).toHaveBeenCalledOnce()
    const env = capturedInput?.['env'] as Record<string, string> | undefined
    expect(env?.['KB_WORKSPACE_ROOT']).toBe('/main/workspace')
  })

  it('passes the declared timeout to the execution boundary', async () => {
    let capturedTimeout: number | undefined
    const backendCapturingTimeout = {
      execute: vi.fn().mockImplementation(async (req: { timeoutMs?: number }) => {
        capturedTimeout = req.timeoutMs
        return { ok: true, outputs: {}, stdout: '', stderr: '', exitCode: 0 }
      }),
    }

    const runner = new SandboxRunner({

      backend: backendCapturingTimeout as any,

      cliApi: mockCliApi as any,
      workspaceRoot: '/main/workspace',
    })

    await runner.execute(
      makeRequest({
        spec: {
          name: 'shell-step',
          uses: 'builtin:shell',
          with: { command: 'echo test' },
          timeoutMs: 3600000, // 1 hour from YAML
        },
      }),
    )

    expect(capturedTimeout).toBe(3600000)
  })
})
