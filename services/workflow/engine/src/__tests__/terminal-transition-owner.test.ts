import { describe, expect, it } from 'vitest';
import { isTerminal } from '@kb-labs/workflow-constants';
import type { IStorage } from '@kb-labs/core-platform';
import { RunSchema, type WorkflowRun } from '@kb-labs/workflow-contracts';
import { InMemoryCache, InMemoryEventBus } from '@kb-labs/core-platform/inmemory';
import { mockLogger, mockStorage } from '@kb-labs/shared-testing';
import { EnvSecretProvider } from '../secrets.js';
import { WorkflowEngine } from '../engine.js';

describe('single owner for run terminal transitions', () => {
  it('persists every terminal status through the terminal transition owner', async () => {
    const scenarios = [
      { status: 'success', finish: (engine: WorkflowEngine, run: WorkflowRun, jobId: string) => engine.markJobCompleted(run.id, jobId) },
      { status: 'failed', finish: (engine: WorkflowEngine, run: WorkflowRun, jobId: string) => engine.markJobFailed(run.id, jobId, new Error('step failed'), undefined, false) },
      { status: 'cancelled', finish: (engine: WorkflowEngine, run: WorkflowRun) => engine.cancelRun(run.id) },
      { status: 'dlq', finish: (engine: WorkflowEngine, run: WorkflowRun) => engine.finalizeRun(run.id, 'dlq') },
    ] as const;

    for (const scenario of scenarios) {
      const backingStorage = mockStorage();
      const writes: Array<[string, Buffer]> = [];
      const storage: IStorage = {
        read: (path) => backingStorage.read(path),
        write: async (path, data) => { writes.push([path, data]); await backingStorage.write(path, data) },
        delete: (path) => backingStorage.delete(path),
        list: (prefix) => backingStorage.list(prefix),
        exists: (path) => backingStorage.exists(path),
      };
      const logger = mockLogger();
      const engine = new WorkflowEngine({
        projectId: 'prj_0000000000000001',
        cache: new InMemoryCache(), storage, events: new InMemoryEventBus(), logger,
        secretProvider: new EnvSecretProvider(),
      });
      const run = await engine.createRun({
        spec: { name: `terminal-${scenario.status}`, version: '1.0.0', on: { manual: true }, jobs: {
          job: { runsOn: 'local', steps: [{ name: 'Step', uses: 'builtin:shell', with: { run: 'true' } }] },
        } },
        trigger: { type: 'manual' },
      });
      await expect(engine.updateRun(run.id, (draft) => { draft.status = scenario.status })).rejects.toThrow(
        'can only be written by the terminal transition owner',
      );
      const jobId = run.jobs[0]!.id;
      await engine.markJobStarted(run.id, jobId);
      await scenario.finish(engine, run, jobId);

      const observedTransitions: Array<{ runId: string; status: string }> = [];
      const lastStatusByRun = new Map<string, WorkflowRun['status']>();
      for (const [path, payload] of writes) {
        if (!path.startsWith('workflows/')) { continue; }
        const parsed = RunSchema.safeParse(JSON.parse(payload.toString('utf8')));
        if (!parsed.success) { continue; }
        const previousStatus = lastStatusByRun.get(parsed.data.id);
        if (previousStatus !== undefined && !isTerminal(previousStatus, 'run') && isTerminal(parsed.data.status, 'run')) {
          observedTransitions.push({ runId: parsed.data.id, status: parsed.data.status });
        }
        lastStatusByRun.set(parsed.data.id, parsed.data.status);
      }
      const ownedTransitions = logger.messages
        .filter((entry) => entry.msg === 'Workflow run terminal state persisted')
        .map((entry) => ({ runId: entry.meta?.runId as string, status: entry.meta?.status as string }));

      expect(observedTransitions).toEqual([{ runId: run.id, status: scenario.status }]);
      expect(ownedTransitions).toEqual(observedTransitions);
    }
  });
});
