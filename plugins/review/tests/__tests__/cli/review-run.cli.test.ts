import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

// Mock SDK hooks before importing the command
vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...original,
    useLoader: vi.fn(),
    useConfig: vi.fn(),
  };
});

// Mock review-core functions
vi.mock('../../../src/core/index.js', () => ({
  runReview: vi.fn(),
  resolveGitScope: vi.fn(),
  getReposWithChanges: vi.fn(),
}));

import { useLoader, useConfig } from '@kb-labs/sdk';
import { runReview, resolveGitScope, getReposWithChanges } from '../../../src/core/index.js';
import type { ScopedFiles } from '../../../src/core/index.js';
import type { ReviewResult } from '@kb-labs/review/contracts';
import reviewRunCommand from '../../../src/commands/run.js';

const mockedUseLoader = vi.mocked(useLoader);
const mockedUseConfig = vi.mocked(useConfig);
const mockedRunReview = vi.mocked(runReview);
const mockedResolveGitScope = vi.mocked(resolveGitScope);
const mockedGetReposWithChanges = vi.mocked(getReposWithChanges);

/** No-op loader stub that satisfies the useLoader interface */
const noopLoader = {
  start: vi.fn(),
  succeed: vi.fn(),
  fail: vi.fn(),
  update: vi.fn(),
  stop: vi.fn(),
};

/** Minimal ReviewResult with no findings */
function makeReviewResult(findings: Array<{ severity: string; file: string; line: number; message: string }> = []) {
  return {
    findings,
    metadata: {
      analyzedFiles: 3,
      engines: ['heuristic'],
      incremental: null,
    },
  };
}

/** Mock ctx.runtime.fs for file-based scope */
function makeRuntimeMock(files: string[] = []) {
  return {
    fs: {
      glob: vi.fn().mockResolvedValue(files),
      readFile: vi.fn().mockResolvedValue('// file content'),
    },
  } as unknown as ReturnType<typeof createMockContext>['runtime'];
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedUseLoader.mockReturnValue(noopLoader as unknown as ReturnType<typeof useLoader>);
  mockedUseConfig.mockResolvedValue(null);
  // Default: no changed repos → no files → validationError path
  mockedGetReposWithChanges.mockResolvedValue([]);
  mockedResolveGitScope.mockResolvedValue({ files: [] } as unknown as ScopedFiles);
});

describe('review:run', () => {
  it('RR-01: no changed files — exitCode 1 with validation message', async () => {
    // Default mocks: no repos, no files → "no files to review"
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await reviewRunCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(noopLoader.fail).toHaveBeenCalled();
  });

  it('RR-02: changed files found — runs review, exitCode 0 when no blockers', async () => {
    mockedGetReposWithChanges.mockResolvedValue(['packages/core']);
    mockedResolveGitScope.mockResolvedValue({
      files: [{ path: 'packages/core/src/index.ts', content: 'export {}' }],
    } as unknown as ScopedFiles);
    mockedRunReview.mockResolvedValue(makeReviewResult() as unknown as ReviewResult);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await reviewRunCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).not.toHaveProperty('ok');
    expect(mockedRunReview).toHaveBeenCalledOnce();
    expect(captured.success.length + captured.warnings.length).toBeGreaterThan(0);
  });

  it('RR-03: blocker finding — exitCode 1', async () => {
    mockedGetReposWithChanges.mockResolvedValue(['packages/core']);
    mockedResolveGitScope.mockResolvedValue({
      files: [{ path: 'src/index.ts', content: 'eval("x")' }],
    } as unknown as ScopedFiles);
    mockedRunReview.mockResolvedValue(makeReviewResult([
      { severity: 'blocker', file: 'src/index.ts', line: 1, message: 'eval is dangerous' },
    ]) as unknown as ReviewResult);

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await reviewRunCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({
      ok: false,
      error: {
        diagnostics: [{ code: 'KB_REVIEW_FINDING', path: 'src/index.ts', message: 'eval is dangerous' }],
      },
    });
  });

  // case: S-203.1
  it('returns the same agent report in JSON mode as the human command result', async () => {
    mockedGetReposWithChanges.mockResolvedValue(['packages/core']);
    mockedResolveGitScope.mockResolvedValue({
      files: [{ path: 'src/a.ts', content: '' }],
    } as unknown as ScopedFiles);
    const reviewResult = makeReviewResult();
    mockedRunReview.mockResolvedValue(reviewResult as unknown as ReviewResult);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await reviewRunCommand.execute(ctx, mockCLIInput({ flags: { json: true } }));

    expect(captured.json).toHaveLength(0);
    expect(result).toEqual({ passed: true, issues: [], summary: 'Review passed. No issues found.' });
  });

  // case: S-203.1
  it('keeps blocker failures in JSON mode instead of returning the success report', async () => {
    mockedGetReposWithChanges.mockResolvedValue(['packages/core']);
    mockedResolveGitScope.mockResolvedValue({
      files: [{ path: 'src/a.ts', content: 'eval("x")' }],
    } as unknown as ScopedFiles);
    mockedRunReview.mockResolvedValue(makeReviewResult([
      { severity: 'blocker', file: 'src/a.ts', line: 1, message: 'eval is dangerous' },
    ]) as unknown as ReviewResult);

    const { ui } = createCapturedUI();
    const result = await reviewRunCommand.execute(
      createMockContext({ ui }),
      mockCLIInput({ flags: { json: true } }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_COMMAND_FAILED',
        diagnostics: [{ code: 'KB_REVIEW_FINDING', path: 'src/a.ts', message: 'eval is dangerous' }],
      },
    });
  });

  it('RR-05: --scope=staged uses includeStaged filter', async () => {
    mockedGetReposWithChanges.mockResolvedValue(['packages/core']);
    mockedResolveGitScope.mockResolvedValue({ files: [{ path: 'a.ts', content: '' }] } as unknown as ScopedFiles);
    mockedRunReview.mockResolvedValue(makeReviewResult() as unknown as ReviewResult);

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await reviewRunCommand.execute(ctx, mockCLIInput({ flags: { scope: 'staged' } }));

    expect(mockedResolveGitScope).toHaveBeenCalledWith(
      expect.objectContaining({ includeStaged: true, includeUnstaged: false }),
    );
  });

  it('RR-06: --repos flag skips getReposWithChanges, uses resolveGitScope directly', async () => {
    mockedResolveGitScope.mockResolvedValue({ files: [{ path: 'b.ts', content: '' }] } as unknown as ScopedFiles);
    mockedRunReview.mockResolvedValue(makeReviewResult() as unknown as ReviewResult);

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await reviewRunCommand.execute(ctx, mockCLIInput({ flags: { repos: ['packages/ui'] } }));

    expect(mockedGetReposWithChanges).not.toHaveBeenCalled();
    expect(mockedResolveGitScope).toHaveBeenCalledWith(
      expect.objectContaining({ repos: ['packages/ui'] }),
    );
  });

  it('RR-07: runReview throws — exitCode 1, loader.fail called', async () => {
    mockedGetReposWithChanges.mockResolvedValue(['packages/core']);
    mockedResolveGitScope.mockResolvedValue({ files: [{ path: 'c.ts', content: '' }] } as unknown as ScopedFiles);
    mockedRunReview.mockRejectedValue(new Error('LLM timeout'));

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await reviewRunCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(noopLoader.fail).toHaveBeenCalled();
  });

  it('keeps a malformed analysis hint attributable through review run error handling', async () => {
    mockedGetReposWithChanges.mockResolvedValue(['packages/core']);
    mockedResolveGitScope.mockResolvedValue({ files: [{ path: 'c.ts', content: '' }] } as unknown as ScopedFiles);
    mockedRunReview.mockRejectedValue(Object.assign(new Error('Review failed.'), {
      code: 'REVIEW_FAILED',
      hint: { message: 'Review failed', interpolation: { file: 'src/a.ts' } },
    }));

    const { ui } = createCapturedUI();
    const result = await reviewRunCommand.execute(createMockContext({ ui }), mockCLIInput({ flags: { json: true } }));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_PLUGIN_CONTRACT_VIOLATION',
        details: {
          field: 'hint',
          observedType: 'object',
          observedValuePreview: expect.stringContaining('Review failed'),
        },
      },
    });
  });

  it('RR-08: --files flag reads specific files via ctx.runtime.fs.glob', async () => {
    mockedRunReview.mockResolvedValue(makeReviewResult() as unknown as ReviewResult);

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    // Inject runtime mock with glob
    const runtime = makeRuntimeMock(['src/target.ts']);
    (ctx as { runtime: typeof runtime }).runtime = runtime;

    await reviewRunCommand.execute(ctx, mockCLIInput({ flags: { files: ['src/*.ts'] } }));

    expect(runtime.fs.glob).toHaveBeenCalled();
    expect(mockedRunReview).toHaveBeenCalledWith(
      expect.objectContaining({ files: expect.any(Array) }),
    );
  });
});
