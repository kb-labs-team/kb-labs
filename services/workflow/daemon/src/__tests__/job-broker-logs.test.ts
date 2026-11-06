/**
 * Regression tests for JobBroker log query defensiveness.
 *
 * Bug: `platform.logs.query()` can return `{ logs: null }` or `{ logs: undefined }`
 * (e.g. noop adapter in worker-pool mode). The old code cast the result to
 * `LogEntry[]` and called `.filter()` on it, throwing TypeError → HTTP 500.
 *
 * Fix: `(queryResult.logs ?? [])` — tested here.
 */

import { describe, it, expect, vi } from 'vitest';
import { mockLogger } from '@kb-labs/shared-testing';
import { JobBroker } from '../job-broker.js';

function buildPlatform(logsResult: unknown) {
  return {
    logs: {
      query: vi.fn(async () => logsResult),
    },
  };
}

function buildEngine(run: unknown) {
  return {
    getRun: vi.fn(async () => run),
    runFromInline: vi.fn(),
    cancelRun: vi.fn(),
  };
}


describe('JobBroker._queryLogs — null/undefined log safety', () => {
  it('returns [] when platform.logs.query returns { logs: null }', async () => {
    const run = {
      id: 'run-1',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    const broker = new JobBroker(
      buildEngine(run) as never,
      mockLogger(),
      buildPlatform({ logs: null }) as never,
    );

    const result = await broker.getJobLogs('run-1');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('returns [] when platform.logs.query returns { logs: undefined }', async () => {
    const run = {
      id: 'run-2',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    const broker = new JobBroker(
      buildEngine(run) as never,
      mockLogger(),
      buildPlatform({ logs: undefined }) as never,
    );

    const result = await broker.getJobLogs('run-2');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('returns [] when platform.logs.query returns {} (no logs property)', async () => {
    const run = {
      id: 'run-3',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    const broker = new JobBroker(
      buildEngine(run) as never,
      mockLogger(),
      buildPlatform({}) as never,
    );

    const result = await broker.getJobLogs('run-3');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('reconstructs completed step output from the durable run record after restart', async () => {
    const run = {
      id: 'run-persisted',
      createdAt: '2026-10-01T00:00:00.000Z',
      finishedAt: '2026-10-01T00:00:05.000Z',
      jobs: [{ steps: [{
        id: 'step-1', name: 'Print known line', finishedAt: '2026-10-01T00:00:04.000Z',
        outputs: { stdout: 'durable-workflow-log\n', stderr: '' },
      }] }],
    };
    const broker = new JobBroker(
      buildEngine(run) as never,
      mockLogger(),
      buildPlatform({ logs: [] }) as never,
    );

    await expect(broker.getRunLogs('run-persisted')).resolves.toMatchObject([{
      timestamp: '2026-10-01T00:00:04.000Z', level: 'info',
      message: 'durable-workflow-log', stepId: 'step-1', stepName: 'Print known line', stream: 'stdout',
    }]);
  });

  it('filters out log entries with missing fields object', async () => {
    const run = {
      id: 'run-4',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    const broker = new JobBroker(
      buildEngine(run) as never,
      mockLogger(),
      buildPlatform({
        logs: [
          // Entry with valid fields matching runId
          { timestamp: Date.now(), level: 'info', message: 'ok', fields: { runId: 'run-4' } },
          // Entry with missing fields — must not throw
          { timestamp: Date.now(), level: 'info', message: 'no-fields' },
          // Entry with null fields — must not throw
          { timestamp: Date.now(), level: 'info', message: 'null-fields', fields: null },
        ],
      }) as never,
    );

    const result = await broker.getJobLogs('run-4');
    expect(Array.isArray(result)).toBe(true);
    // Only the valid entry matching runId-4 should survive
    expect(result).toHaveLength(1);
    expect(result.map((r) => r.message)).toEqual(['ok']);
  });

  it('returns [] when run does not exist', async () => {
    const broker = new JobBroker(
      buildEngine(null) as never,
      mockLogger(),
      buildPlatform({ logs: [] }) as never,
    );

    const result = await broker.getJobLogs('nonexistent');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('returns [] when platform.logs.query() throws (no log backend configured)', async () => {
    // HybridLogReader throws "No log storage backend available" when neither
    // logPersistence nor logRingBuffer is configured. The endpoint must return
    // 200+[] rather than propagating the error as 500.
    const run = {
      id: 'run-5',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    const broker = new JobBroker(
      buildEngine(run) as never,
      mockLogger(),
      {
        logs: {
          query: vi.fn(async () => {
            throw new Error('No log storage backend available. Configure logPersistence or logRingBuffer in kb.config.json');
          }),
        },
      } as never,
    );

    const result = await broker.getJobLogs('run-5');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});
