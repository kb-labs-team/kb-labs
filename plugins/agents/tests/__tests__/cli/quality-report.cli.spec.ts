import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveRuntimeStatePath } from '@kb-labs/sdk';
import { manifest } from '../../../src/manifest.js';
import { getHandlerPermissions } from '../../../../../core/plugin-contracts/src/manifest.js';

import qualityReportCommand from '../../../src/cli/commands/quality-report.js';

describe('agents:quality:report governed analytics fallback', () => {
  let cwd: string;
  let previousCwd: string;
  let previousKbHome: string | undefined;

  beforeEach(async () => {
    previousCwd = process.cwd();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agents-quality-report-'));
    previousKbHome = process.env.KB_HOME;
    process.env.KB_HOME = path.join(tempDir, 'kb-home');
    process.chdir(tempDir);
    cwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    if (previousKbHome === undefined) {
      delete process.env.KB_HOME;
    } else {
      process.env.KB_HOME = previousKbHome;
    }
    await rm(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // case: S-309.2
  it('grants sqlite3 only to the quality report command', () => {
    const qualityPermissions = getHandlerPermissions(manifest as never, 'cli', 'agent quality report show');
    const tracePermissions = getHandlerPermissions(manifest as never, 'cli', 'agent trace doctor');

    expect(qualityPermissions.shell?.allow).toEqual(['sqlite3']);
    expect(qualityPermissions.quotas?.timeoutMs).toBe(5_000);
    expect(tracePermissions.shell).toBeUndefined();
  });

  // case: S-309.1
  it('returns an empty report without requiring shell access when analytics are absent', async () => {
    const shellExec = vi.fn();
    const ctx = { host: 'cli', api: { shell: { exec: shellExec } } } as never;

    const result = await qualityReportCommand.execute(ctx, { days: 1, json: true });

    expect(result).toEqual({
      success: true,
      message: 'No analytics files found for selected period',
      runs: 0,
    });
    expect(shellExec).not.toHaveBeenCalled();
  });

  // case: S-309.2
  it('reads SQLite fallback rows through the governed shell API', async () => {
    const analyticsDir = path.dirname(resolveRuntimeStatePath(cwd, ['analytics', 'analytics.sqlite']));
    const bufferDir = resolveRuntimeStatePath(cwd, ['analytics', 'buffer']);
    await mkdir(bufferDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    await writeFile(path.join(bufferDir, `events-${day}.jsonl`), `${JSON.stringify({
      type: 'unrelated.event',
      ts: new Date().toISOString(),
      payload: {},
    })}\n`);
    await writeFile(path.join(analyticsDir, 'analytics.sqlite'), 'fixture database marker');

    const now = new Date().toISOString();
    const shellExec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{
        type: 'agent.kpi.run_completed',
        ts: now,
        payload: JSON.stringify({
          sessionId: 'sqlite-fixture-session',
          success: true,
          task: 'fixture task',
          tokensUsed: 42,
          durationMs: 1200,
          iterationsUsed: 1,
          iterationBudget: 3,
          toolCallsTotal: 2,
          toolErrorRate: 0,
          qualityGate: { status: 'pass', score: 1 },
        }),
      }]),
      stderr: '',
      ok: true,
    });
    const ctx = { host: 'cli', api: { shell: { exec: shellExec } } } as never;

    const result = await qualityReportCommand.execute(ctx, { days: 1, json: true });

    expect(shellExec).toHaveBeenCalledOnce();
    expect(shellExec.mock.calls[0]?.[0]).toBe('sqlite3');
    expect(shellExec.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      '-readonly', '-safe', '-batch', '-json', '-init', '/dev/null',
    ]));
    expect(shellExec.mock.calls[0]?.[2]).toMatchObject({
      cwd,
      timeout: 5_000,
      maxOutputBytes: 2 * 1024 * 1024,
      throwOnError: false,
    });
    expect(result).toMatchObject({ success: true, report: { runs: 1 } });
    expect(JSON.stringify(result)).toContain('sqlite-fixture-session');
  });

  // case: S-309.4
  it('reads SQLite events when no JSONL analytics file exists', async () => {
    const analyticsDir = path.dirname(resolveRuntimeStatePath(cwd, ['analytics', 'analytics.sqlite']));
    await mkdir(analyticsDir, { recursive: true });
    await writeFile(path.join(analyticsDir, 'analytics.sqlite'), 'fixture database marker');

    const shellExec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{
        type: 'agent.kpi.run_completed',
        ts: new Date().toISOString(),
        payload: JSON.stringify({ sessionId: 'sqlite-only-session', success: true }),
      }]),
      stderr: '',
      ok: true,
    });
    const ctx = { host: 'cli', api: { shell: { exec: shellExec } } } as never;

    const result = await qualityReportCommand.execute(ctx, { days: 1, json: true });

    expect(shellExec).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: true, report: { runs: 1 } });
    expect(JSON.stringify(result)).toContain('sqlite-only-session');
  });

  // case: S-309.3
  it('returns an empty report when the governed sqlite3 process is unavailable', async () => {
    const analyticsDir = path.dirname(resolveRuntimeStatePath(cwd, ['analytics', 'analytics.sqlite']));
    const bufferDir = resolveRuntimeStatePath(cwd, ['analytics', 'buffer']);
    await mkdir(bufferDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    await writeFile(path.join(bufferDir, `events-${day}.jsonl`), `${JSON.stringify({
      type: 'unrelated.event',
      ts: new Date().toISOString(),
      payload: {},
    })}\n`);
    await writeFile(path.join(analyticsDir, 'analytics.sqlite'), 'fixture database marker');

    const shellExec = vi.fn().mockRejectedValue(new Error('Failed to spawn sqlite3: ENOENT'));
    const ctx = { host: 'cli', api: { shell: { exec: shellExec } } } as never;

    const result = await qualityReportCommand.execute(ctx, { days: 1, json: true });

    expect(shellExec).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: true, report: { runs: 0 } });
  });
});
