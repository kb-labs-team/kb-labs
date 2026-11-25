import { describe, expect, it, vi } from 'vitest';
import type { IEntityRegistry } from '@kb-labs/plugin-contracts';
import type { ExecutionBackend, ExecutionRequest } from '@kb-labs/plugin-execution';
import { SandboxRunner } from '../sandbox-runner.js';
import type { StepExecutionRequest } from '../../types.js';

describe('SandboxRunner CLI command workspace routing', () => {
  // case: S-325.2
  it('uses the isolated task worktree for CLI cwd and execution workspace', async () => {
    let captured: ExecutionRequest | undefined;
    const backend = {
      execute: vi.fn(async (request: ExecutionRequest) => {
        captured = request;
        return { ok: true, data: { ok: true, outputs: {} } };
      }),
    } as unknown as ExecutionBackend;
    const cliApi = {
      snapshot: () => ({
        manifests: [{
          pluginId: '@kb-labs/qa',
          pluginRoot: '/project/plugins/qa',
          manifest: {
            version: '1.0.0',
            permissions: {},
            configSection: 'qa',
            cli: {
              commands: [{ path: 'qa run', handler: 'dist/cli/commands/qa-run.js' }],
            },
          },
        }],
      }),
    } as unknown as IEntityRegistry;
    const runner = new SandboxRunner({ backend, cliApi, workspaceRoot: '/project' });
    const request: StepExecutionRequest = {
      spec: { name: 'Run scoped QA', uses: 'command:qa run', with: { tasks: 'test' } },
      context: {
        runId: 'run-1',
        jobId: 'run-1:dogfood',
        stepId: 'qa',
        attempt: 1,
        env: {
          KB_PROJECT_ROOT: '/project',
          KB_WORKSPACE_ROOT: '/project/.worktrees/wt_run-1',
        },
        secrets: {},
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      workspace: '/project',
    };

    await runner.execute(request);

    expect(backend.execute).toHaveBeenCalledOnce();
    expect(captured?.input).toEqual({
      argv: [],
      flags: { tasks: 'test' },
      cwd: '/project/.worktrees/wt_run-1',
    });
    expect(captured?.workspace).toEqual({ type: 'local', cwd: '/project/.worktrees/wt_run-1' });
  });
});
