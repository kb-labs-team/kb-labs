/**
 * @module @kb-labs/core-runtime/__tests__/environment-init-platform.e2e
 * E2E-like integration checks for environment orchestration via initPlatform.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { IDocumentDatabase } from '@kb-labs/core-platform/adapters';
import { initPlatform, resetPlatform } from '../loader.js';
import { platform } from '../container.js';
import { startFullCycle } from '../use-cases/start-full-cycle.js';
import { EnvironmentManager } from '../environment-manager.js';
import { RunExecutor } from '../run-executor.js';
import { RunOrchestrator } from '../run-orchestrator.js';

const executeMock = vi.fn(async () => ({
  ok: true,
  data: { ok: true },
  executionTimeMs: 1,
}));
const shutdownMock = vi.fn(async () => undefined);
const createExecutionBackendMock = vi.fn(() => ({
  execute: executeMock,
  shutdown: shutdownMock,
}));

vi.mock('@kb-labs/plugin-execution-factory/construct', () => ({
  createExecutionBackend: createExecutionBackendMock,
}));

function hasDocker(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasAdapterPackage(moduleName: string): boolean {
  try {
    const require = createRequire(import.meta.url);
    require.resolve(moduleName);
    return true;
  } catch {
    return false;
  }
}

describe('initPlatform environment orchestration e2e', () => {
  beforeEach(() => {
    resetPlatform();
    executeMock.mockClear();
    shutdownMock.mockClear();
    createExecutionBackendMock.mockClear();
  });

  afterEach(async () => {
    try {
      await platform.shutdown();
    } catch {
      // Best-effort shutdown in tests.
    }
    resetPlatform();
  });

  // case: S-243.9
  it('passes the selected host platform root to the local execution backend', async () => {
    const platformRoot = path.resolve(process.cwd(), '../../..');

    await initPlatform({ execution: { mode: 'in-process' } }, process.cwd(), undefined, platformRoot);

    expect(createExecutionBackendMock).toHaveBeenCalledWith(expect.objectContaining({ platformRoot }));
  });

  // case: S-243.9
  it('does not infer a host platform root from process environment when none was selected', async () => {
    const previousRoot = process.env.KB_PLATFORM_ROOT;
    process.env.KB_PLATFORM_ROOT = path.join(process.cwd(), 'request-controlled-root');
    try {
      await initPlatform({ execution: { mode: 'in-process' } }, process.cwd());

      expect(createExecutionBackendMock).toHaveBeenCalledWith(expect.objectContaining({ platformRoot: undefined }));
    } finally {
      if (previousRoot === undefined) { delete process.env.KB_PLATFORM_ROOT; }
      else { process.env.KB_PLATFORM_ROOT = previousRoot; }
    }
  });

  it.skipIf(
    !hasDocker() ||
      !hasAdapterPackage('@kb-labs/adapters-sqlite') ||
      !hasAdapterPackage('@kb-labs/adapters-environment-docker')
  )(
    'initializes orchestration services and cleans expired lease via janitor flow',
    async () => {
      const workspaceRoot = path.resolve(process.cwd(), '../../..');
      const originalProcessSend = (process as any).send;
      (process as any).send = undefined;

      try {
        await initPlatform(
          {
            adapters: {
              db: '@kb-labs/adapters-sqlite',
              environment: '@kb-labs/adapters-environment-docker',
            } as any,
            adapterOptions: {
              db: {
                filename: ':memory:',
              },
              environment: {
                defaultImage: 'alpine:3.20',
                autoRemove: true,
                mountWorkspace: false,
                defaultTtlMs: 250,
                janitorIntervalMs: 100,
                janitorBatchSize: 10,
              },
            } as any,
            execution: {
              mode: 'in-process',
            },
          },
          workspaceRoot
        );
      } finally {
        (process as any).send = originalProcessSend;
      }

      if (!platform.hasExecutionBackend) {
        const mockBackend = createExecutionBackendMock();
        platform.initExecutionBackend(mockBackend as any);

        const environmentManager = new EnvironmentManager(platform, {
          janitorIntervalMs: 100,
          janitorBatchSize: 10,
        });
        const runExecutor = new RunExecutor(platform.executionBackend, platform.logger);
        const runOrchestrator = new RunOrchestrator(
          environmentManager,
          runExecutor,
          platform.logger
        );
        platform.initOrchestrationServices(environmentManager, runExecutor, runOrchestrator);
        environmentManager.startJanitor();
      }

      expect(platform.hasExecutionBackend).toBe(true);
      expect(platform.getConfiguredServices().has('environmentManager')).toBe(true);
      expect(platform.getConfiguredServices().has('runExecutor')).toBe(true);
      expect(platform.getConfiguredServices().has('runOrchestrator')).toBe(true);

      const run = await startFullCycle(platform, {
        run: {
          taskRef: 'TASK-E2E-1',
          templateId: 'full-cycle.default',
        },
        environment: {
          ttlMs: 200,
          command: ['sleep', '30'],
        },
        firstStep: {
          executionId: 'exec-e2e-1',
          descriptor: {
            hostType: 'workflow',
            hostContext: {
              host: 'workflow',
              workflowId: 'wf-e2e-1',
              runId: 'run-e2e-1',
              stepId: 'step-e2e-1',
            },
            permissions: {},
            pluginId: 'e2e-plugin',
            pluginVersion: '1.0.0',
            requestId: 'req-e2e-1',
          },
          pluginRoot: workspaceRoot,
          handlerRef: 'noop-handler',
          input: { smoke: true },
        },
      });

      expect(run.status).toBe('completed');
      expect(run.environmentId).toBeTruthy();
      expect(executeMock).toHaveBeenCalledTimes(1);

      const environmentId = run.environmentId!;
      const cleaned = await platform.environmentManager!.cleanupExpiredLeases(
        new Date(Date.now() + 5_000)
      );
      expect(cleaned).toBeGreaterThanOrEqual(1);

      const status = await platform.environmentManager!.getEnvironmentStatus(environmentId);
      expect(status.status).toBe('terminated');

      const docs = platform.getAdapter<IDocumentDatabase>('documentDatabase')!;
      const leases = await docs.find<{ id: string; createdAt: number; updatedAt: number; status: string; environmentId: string }>(
        'environment_leases',
        { environmentId: { $eq: environmentId } },
        { limit: 1 },
      );
      expect(leases[0]?.status).toBe('terminated');
    }
  );
});
