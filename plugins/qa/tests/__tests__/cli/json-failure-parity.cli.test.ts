import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useConfig: vi.fn(),
  resolveDevkitBin: vi.fn(),
  captureGit: vi.fn(),
  gate: vi.fn(),
  check: vi.fn(),
  run: vi.fn(),
  saveRun: vi.fn(),
  loadBaseline: vi.fn(),
  latestCheck: vi.fn(),
  latestStats: vi.fn(),
  loadRunHistory: vi.fn(),
  compareWithBaseline: vi.fn(),
  detectRegressions: vi.fn(),
}));

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return { ...actual, useConfig: mocks.useConfig };
});

vi.mock('../../../src/core/index.js', () => ({
  DevkitAdapter: class {
    gate() { return mocks.gate(); }
    check() { return mocks.check(); }
    run() { return mocks.run(); }
  },
  SnapshotStore: class {
    saveGate() { return null; }
    saveCheck() { return null; }
    saveRun() { return mocks.saveRun(); }
    loadBaseline() { return mocks.loadBaseline(); }
    latestCheck() { return mocks.latestCheck(); }
    latestStats() { return mocks.latestStats(); }
    loadRunHistory() { return mocks.loadRunHistory(); }
  },
  resolveDevkitBin: mocks.resolveDevkitBin,
  captureGit: mocks.captureGit,
  buildCheckReport: vi.fn(() => []),
  buildCheckJsonReport: vi.fn(() => ({ schema: 'qa-check-report/v1' })),
  buildRunReport: vi.fn(() => []),
  buildRunJsonReport: vi.fn(() => ({ schema: 'qa-run-report/v1' })),
  compareWithBaseline: mocks.compareWithBaseline,
  buildBaselineDiffReport: vi.fn(() => []),
  detectRegressions: mocks.detectRegressions,
  buildRegressionsReport: vi.fn(() => []),
}));

import qaGate from '../../../src/cli/commands/qa-gate.js';
import qaCheck from '../../../src/cli/commands/qa-check.js';
import qaRun from '../../../src/cli/commands/qa-run.js';
import baselineDiff from '../../../src/cli/commands/baseline-diff.js';
import qaRegressions from '../../../src/cli/commands/qa-regressions.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.useConfig.mockResolvedValue(null);
  mocks.resolveDevkitBin.mockReturnValue('/workspace/node_modules/.bin/kb-devkit');
  mocks.captureGit.mockResolvedValue({ commit: 'abc123', branch: 'main', message: 'test' });
  mocks.gate.mockResolvedValue({
    ok: false,
    staged_files: 1,
    violations: [{ package: '@kb-labs/test', check: 'manifest', severity: 'error', message: 'invalid manifest' }],
  });
  mocks.check.mockResolvedValue({
    ok: false,
    packages: { '@kb-labs/test': { ok: false, issues: [{ check: 'manifest', severity: 'error', message: 'invalid manifest' }] } },
  });
  mocks.run.mockResolvedValue({
    elapsed: '1s',
    ok: false,
    results: [{ Package: '@kb-labs/test', Task: 'build', OK: false, Cached: false, Elapsed: 1, ExitCode: 1, Stdout: '', Stderr: 'build failed', Error: 'build failed' }],
    summary: { total: 1, passed: 0, failed: 1, cached: 0 },
  });
  mocks.loadBaseline.mockReturnValue({ check: {}, stats: {} });
  mocks.latestCheck.mockReturnValue({ raw: {} });
  mocks.latestStats.mockReturnValue({ raw: {} });
  mocks.loadRunHistory.mockReturnValue([]);
  mocks.compareWithBaseline.mockReturnValue({
    newIssues: [], fixedIssues: [], persistingIssues: [], newIssueCount: 1,
    fixedIssueCount: 0, scoreDelta: 0, gradeDelta: 'B → B',
  });
  mocks.detectRegressions.mockReturnValue({
    hasRegressions: true,
    regressions: [{ task: 'build', delta: 1, newFailures: ['@kb-labs/test'] }],
    comparedAt: { previous: 'before', current: 'after' },
  });
});

async function execute(command: { execute: (context: never, input: never) => unknown }, flags: Record<string, unknown>): Promise<unknown> {
  const ui = { success: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return command.execute(
    { ui, cwd: '/workspace', api: { shell: {} } } as never,
    { flags } as never,
  );
}

describe('QA command failure parity', () => {
  // case: S-203.1
  it('maps gate findings before choosing JSON or human presentation', async () => {
    const json = await execute(qaGate, { json: true });
    const human = await execute(qaGate, {});
    expect(json).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', diagnostics: [{ code: 'KB_QA_GATE_VIOLATION' }] } });
    expect(human).toEqual(json);
  });

  // case: S-203.1
  it('maps check findings before choosing JSON or human presentation', async () => {
    const json = await execute(qaCheck, { json: true, save: false });
    const human = await execute(qaCheck, { save: false });
    expect(json).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', diagnostics: [{ code: 'KB_QA_MANIFEST' }] } });
    expect(human).toEqual(json);
  });

  // case: S-203.1
  it('maps run failures before choosing JSON or human presentation', async () => {
    const json = await execute(qaRun, { json: true, save: false });
    const human = await execute(qaRun, { save: false });
    expect(json).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', diagnostics: [{ code: 'KB_QA_TASK_FAILED' }] } });
    expect(human).toEqual(json);
  });

  // case: S-321.1
  it('preserves devkit input failures that do not contain task results', async () => {
    const failure = {
      ok: false,
      error: {
        code: 'KB_RUNTIME_INPUT_INVALID',
        message: 'Task "unknown-task" is not declared in devkit.yaml.',
        hint: 'Add the task under tasks: in devkit.yaml.',
      },
    };
    mocks.run.mockResolvedValue(failure);

    const json = await execute(qaRun, { json: true, tasks: 'unknown-task' });
    const human = await execute(qaRun, { tasks: 'unknown-task' });

    expect(json).toEqual(failure);
    expect(human).toEqual(failure);
    expect(mocks.saveRun).not.toHaveBeenCalled();
  });

  // case: S-203.1
  it('maps baseline differences before choosing JSON or human presentation', async () => {
    const json = await execute(baselineDiff, { json: true });
    const human = await execute(baselineDiff, {});
    expect(json).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'New issues found' } });
    expect(human).toEqual(json);
  });

  // case: S-203.1
  it('maps regression findings before choosing JSON or human presentation', async () => {
    const json = await execute(qaRegressions, { json: true });
    const human = await execute(qaRegressions, {});
    expect(json).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Regressions found' } });
    expect(human).toEqual(json);
  });
});
