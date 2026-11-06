import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/index.js', async (importOriginal) => ({
  // Keep the real (pure) run-report builders; only stub the I/O entry points.
  ...(await importOriginal<typeof import('../../../src/core/index.js')>()),
  planRelease: vi.fn(),
  runReleaseChecks: vi.fn(),
  resolveScopePath: vi.fn((root: string, scope: string) => `${root}/${scope}`),
}));

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...actual,
    useLoader: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
    })),
    useConfig: vi.fn().mockResolvedValue({ checks: [{ id: 'placeholder', command: 'true' }] }),
    findRepoRoot: vi.fn().mockResolvedValue('/project'),
  };
});

vi.mock('../../../src/shared/run-preflight.js', () => ({ runPreflightFor: vi.fn() }));

vi.mock('../../../src/shared/utils.js', () => ({
  findRepoRoot: vi.fn().mockResolvedValue('/project'),
}));

import { planRelease, runReleaseChecks } from '../../../src/core/index.js';
import { useConfig } from '@kb-labs/sdk';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import { runPreflightFor } from '../../../src/shared/run-preflight.js';
import checksCommand from '../../../src/cli/commands/checks.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(planRelease).mockResolvedValue({ packages: [] } as never);
  vi.mocked(useConfig).mockResolvedValue({ checks: [{ id: 'placeholder', command: 'true' }] } as never);
});

describe('release:checks', () => {
  it('CB-01: all required checks pass — ok:true', async () => {
    vi.mocked(runReleaseChecks).mockResolvedValue([
      { id: 'dist-exports', ok: true, timingMs: 10 },
    ] as never);

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await checksCommand.execute(ctx as never, mockCLIInput({ flags: { json: true } }));

    expect(result).toMatchObject({ ok: true });
  });

  it('CB-02 (regression): a failed optional check must not fail the overall run — ' +
    'ok computation used to be results.every(r => r.ok), ignoring r.optional entirely, ' +
    'so marking a broken check "optional" in config had no effect on the CLI exit code', async () => {
    vi.mocked(runReleaseChecks).mockResolvedValue([
      { id: 'dist-exports', ok: true, timingMs: 10 },
      { id: 'pack-install', ok: false, optional: true, details: { error: 'boom' }, timingMs: 5 },
    ] as never);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await checksCommand.execute(ctx as never, mockCLIInput({ flags: { json: true } }));

    expect(result).toMatchObject({ ok: true, failed: ['pack-install'] });
    expect(result).not.toHaveProperty('result');
  });

  it('CB-03: a failed required (non-optional) check still fails the overall run', async () => {
    vi.mocked(runReleaseChecks).mockResolvedValue([
      { id: 'dist-exports', ok: false, details: { error: 'boom' }, timingMs: 5 },
    ] as never);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await checksCommand.execute(ctx as never, mockCLIInput({ flags: { json: true } }));

    expect(result).toMatchObject({
      ok: false,
      error: { diagnostics: [expect.objectContaining({ message: expect.stringContaining('dist-exports') })] },
    });
  });

  it('returns the same typed failure for failed checks in human and JSON modes', async () => {
    vi.mocked(runReleaseChecks).mockResolvedValue([
      { id: 'dist-exports', ok: false, details: { error: 'missing export' }, timingMs: 5 },
    ] as never);

    const jsonResult = await checksCommand.execute(
      createMockContext({ ui: createCapturedUI().ui, cwd: '/project' }) as never,
      mockCLIInput({ flags: { json: true } }),
    );
    const textResult = await checksCommand.execute(
      createMockContext({ ui: createCapturedUI().ui, cwd: '/project' }) as never,
      mockCLIInput({ flags: {} }),
    );

    expect(jsonResult).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED' } });
    expect(jsonResult).toEqual(textResult);
  });

  it('CB-04: --flow selects flow checks instead of the global check list', async () => {
    vi.mocked(useConfig).mockResolvedValue({
      checks: [{ id: 'global-typecheck', command: 'pnpm', args: ['type-check'] }],
      flows: {
        platform: {
          checks: [{ id: 'dist-exports', command: 'bash', args: ['scripts/gates/check-dist-exports.sh'] }],
        },
      },
    } as never);
    vi.mocked(runReleaseChecks).mockResolvedValue([
      { id: 'dist-exports', ok: true, timingMs: 10 },
    ] as never);

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await checksCommand.execute(ctx as never, mockCLIInput({ flags: { json: true, flow: 'platform' } }));

    expect(result).toMatchObject({ ok: true });
    expect(vi.mocked(runReleaseChecks).mock.calls[0]?.[0]).toEqual([
      { id: 'dist-exports', command: 'bash', args: ['scripts/gates/check-dist-exports.sh'] },
    ]);
  });

  it('CB-04: --json exposes a run report with ALL failing packages and classification, exit semantics unchanged', async () => {
    vi.mocked(runReleaseChecks).mockResolvedValue([
      {
        id: 'pack-install',
        ok: false,
        details: { error: 'exit code 1', exitCode: 1 },
        packages: [
          { path: '/p/a', ok: false, details: { exitCode: 1, error: 'exit code 1', stderr: 'ERROR: local staging registry unreachable at http://localhost:4873' } },
          { path: '/p/b', ok: false, details: { error: 'Process terminated: timeout', stdout: 'Packing b...' } },
        ],
      },
    ] as never);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await checksCommand.execute(ctx as never, mockCLIInput({ flags: { json: true, flow: 'platform' } }));

    expect(result).toMatchObject({
      ok: false,
      error: {
        diagnostics: [
          expect.objectContaining({ message: expect.stringContaining('pack-install (a)'), path: '/p/a' }),
          expect.objectContaining({ message: expect.stringContaining('pack-install (b)'), path: '/p/b' }),
        ],
      },
    });
  });

  it('CB-05: --preflight failing stops before checks run; without the flag preflight is never invoked', async () => {
    const error = { code: 'KB_RELEASE_DOCKER_UNAVAILABLE', area: 'release', stage: 'preflight', severity: 'error', retryable: true, message: 'Docker is not available.', cause: 'down', hint: 'Start Docker' };
    vi.mocked(runPreflightFor).mockResolvedValue({
      ok: false,
      durationMs: 5,
      checks: [{ id: 'docker', status: 'failed', durationMs: 5, message: 'Docker daemon not reachable', error }],
    } as never);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });
    const result = await checksCommand.execute(ctx as never, mockCLIInput({ flags: { json: true, preflight: true } }));

    expect(runReleaseChecks).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: { diagnostics: [expect.objectContaining({ message: expect.stringContaining('preflight:docker') })] },
    });

    vi.mocked(runReleaseChecks).mockResolvedValue([{ id: 'x', ok: true }] as never);
    const { ui: ui2 } = createCapturedUI();
    await checksCommand.execute(createMockContext({ ui: ui2, cwd: '/project' }) as never, mockCLIInput({ flags: { json: true } }));
    expect(runPreflightFor).toHaveBeenCalledTimes(1);
  });

  it('returns the same typed preflight failure in human and JSON modes', async () => {
    const error = { code: 'KB_RELEASE_DOCKER_UNAVAILABLE', area: 'release', stage: 'preflight', severity: 'error', retryable: true, message: 'Docker is not available.', cause: 'down', hint: 'Start Docker' };
    vi.mocked(runPreflightFor).mockResolvedValue({
      ok: false,
      durationMs: 5,
      checks: [{ id: 'docker', status: 'failed', durationMs: 5, message: 'Docker daemon not reachable', error }],
    } as never);

    const jsonResult = await checksCommand.execute(
      createMockContext({ ui: createCapturedUI().ui, cwd: '/project' }) as never,
      mockCLIInput({ flags: { json: true, preflight: true } }),
    );
    const textResult = await checksCommand.execute(
      createMockContext({ ui: createCapturedUI().ui, cwd: '/project' }) as never,
      mockCLIInput({ flags: { preflight: true } }),
    );

    expect(jsonResult).toMatchObject({ ok: false, error: { code: 'KB_RELEASE_DOCKER_UNAVAILABLE' } });
    expect(jsonResult).toEqual(textResult);
  });

  it('CB-06: --preflight passing proceeds to checks', async () => {
    vi.mocked(runPreflightFor).mockResolvedValue({ ok: true, durationMs: 1, checks: [] } as never);
    vi.mocked(runReleaseChecks).mockResolvedValue([{ id: 'x', ok: true }] as never);
    const { ui } = createCapturedUI();
    const result = await checksCommand.execute(createMockContext({ ui, cwd: '/project' }) as never, mockCLIInput({ flags: { json: true, preflight: true } }));
    expect(result).toMatchObject({ ok: true });
    expect(runReleaseChecks).toHaveBeenCalledTimes(1);
  });
});
