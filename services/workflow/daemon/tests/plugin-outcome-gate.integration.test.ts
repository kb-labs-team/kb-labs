import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openCatalog } from '@kb-labs/core-registry';
import { PlatformContainer } from '@kb-labs/core-runtime';
import { mockLogger } from '@kb-labs/shared-testing';
import { EnvSecretProvider, WorkflowEngine } from '@kb-labs/workflow-engine';
import { InMemoryCache, InMemoryEventBus, InMemoryStorage } from '@kb-labs/core-platform/inmemory';
import { createExecutionBackend } from '@kb-labs/plugin-execution-factory/construct';
import { createWorkflowWorker } from '../src/worker.js';

describe('project workflow routes real plugin outcomes', () => {
  let roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots = [];
  });

  // case: S-295.3
  it.each([
    ['partial', 'branch_a', 'branch_b'],
    ['success', 'branch_b', 'branch_a'],
  ] as const)('routes plugin status %s to %s and skips %s', async (status, selectedBranch, skippedBranch) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workflow-plugin-outcome-'));
    roots.push(workspaceRoot);
    const pluginRoot = join(workspaceRoot, 'plugins', 'outcome-router');
    const pluginDist = join(pluginRoot, 'dist');
    const sdkLink = join(pluginRoot, 'node_modules', '@kb-labs', 'sdk');
    await mkdir(pluginDist, { recursive: true });
    await mkdir(join(pluginRoot, 'node_modules', '@kb-labs'), { recursive: true });
    await writeFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "plugins/*"\n');
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
      name: '@kb-labs/outcome-router',
      version: '1.0.0',
      type: 'module',
      kb: { manifest: 'kb.plugin.json' },
      dependencies: { '@kb-labs/sdk': 'workspace:*' },
    }));
    await writeFile(join(pluginRoot, 'kb.plugin.json'), JSON.stringify({
      schema: 'kb.plugin/3',
      id: '@kb-labs/outcome-router',
      version: '1.0.0',
      workflows: {
        handlers: [
          { id: 'result', handler: './dist/handler.js', describe: 'Return a typed workflow outcome' },
          { id: 'branch', handler: './dist/handler.js', describe: 'Record the selected workflow branch' },
        ],
      },
    }));
    await symlink(resolve(process.cwd(), '../../../sdk/sdk'), sdkLink, 'dir');
    await writeFile(join(pluginDist, 'handler.js'), [
      "import { defineHandler } from '@kb-labs/sdk';",
      'export default defineHandler({ execute: async (_ctx, input) => {',
      "  if (typeof input.status === 'string') return { status: input.status };",
      '  return { branch: input.branch };',
      '} });',
    ].join('\n'));

    const registry = await openCatalog(
      { platformRoot: workspaceRoot, projectRoot: workspaceRoot },
      { resolvePlatformVersion: async () => 'test', persistSnapshot: false },
    );
    const logger = mockLogger();
    const projectId = 'prj_0000000000000001';
    const engine = new WorkflowEngine({
      projectId,
      cache: new InMemoryCache(),
      storage: new InMemoryStorage(),
      events: new InMemoryEventBus(),
      logger,
      secretProvider: new EnvSecretProvider(),
      workspaceRoot,
    });
    const run = await engine.createRun({
      spec: {
        name: `plugin-outcome-${status}`,
        version: '1.0.0',
        on: { manual: true },
        jobs: {
          main: {
            runsOn: 'local',
            steps: [
              { id: 'plugin_result', name: 'Plugin result', uses: 'plugin:outcome-router/result', with: { status } },
              {
                id: 'route',
                name: 'Route outcome',
                uses: 'builtin:gate',
                with: {
                  decision: 'steps.plugin_result.outputs.status',
                  routes: {
                    partial: { skipTo: 'branch_a' },
                    success: { skipTo: 'branch_b' },
                  },
                  default: 'fail',
                },
              },
              {
                id: 'branch_a',
                name: 'Partial branch',
                uses: 'plugin:outcome-router/branch',
                if: "steps.plugin_result.outputs.status == 'partial'",
                with: { branch: 'A' },
              },
              {
                id: 'branch_b',
                name: 'Success branch',
                uses: 'plugin:outcome-router/branch',
                if: "steps.plugin_result.outputs.status == 'success'",
                with: { branch: 'B' },
              },
            ],
          },
        },
      },
      trigger: { type: 'manual' },
      metadata: { workflowId: `plugin-outcome-${status}` },
    });
    const platform = new PlatformContainer();
    platform.setAdapter('logger', logger);
    const executionBackend = createExecutionBackend({ platform, mode: 'in-process' });
    const worker = await createWorkflowWorker({
      engine,
      secretProvider: new EnvSecretProvider(),
      cliApi: registry,
      logger,
      platform: { executionBackend, hasExecutionBackend: true, getAdapter: (name) => platform.getAdapter(name) },
      workspaceRoot,
      projectRoot: workspaceRoot,
      projectId,
      concurrency: 1,
    });

    const workerRun = worker.start();
    try {
      await vi.waitFor(async () => {
        const current = await engine.getRun(run.id);
        expect(['success', 'failed']).toContain(current?.status);
      }, { timeout: 8000 });
      const completed = await engine.getRun(run.id);
      if (completed?.status !== 'success') {
        throw new Error(JSON.stringify({ status: completed?.status, result: completed?.result, steps: completed?.jobs[0]?.steps }, null, 2));
      }
      const steps = completed!.jobs[0]!.steps;
      expect(steps.find((step) => step.spec.id === 'plugin_result')).toMatchObject({
        status: 'success', outputs: { status },
      });
      expect(steps.find((step) => step.spec.id === selectedBranch)).toMatchObject({
        status: 'success', outputs: { branch: selectedBranch === 'branch_a' ? 'A' : 'B' },
      });
      expect(steps.find((step) => step.spec.id === skippedBranch)).toMatchObject({
        outputs: { skipped: true },
      });
    } finally {
      await worker.stop();
      await workerRun;
      await executionBackend.shutdown();
      await registry.dispose();
    }
  });
});
