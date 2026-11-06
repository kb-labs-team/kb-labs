import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { execSyncMock } = vi.hoisted(() => ({ execSyncMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: execSyncMock };
});

// Regression test for the recurring GITHUB_WORKFLOW_TOKEN-goes-silently-empty
// incident: when a daemon is restarted from a shell that never exported the
// token, every GitHub step used to 401 with no actionable signal. This
// verifies the fallback to `gh auth token` actually kicks in.
describe('resolveGithubToken', () => {
  const ORIGINAL_ENV = process.env.GITHUB_WORKFLOW_TOKEN;

  beforeEach(() => {
    vi.resetModules();
    execSyncMock.mockReset();
    delete process.env.GITHUB_WORKFLOW_TOKEN;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.GITHUB_WORKFLOW_TOKEN;
    else process.env.GITHUB_WORKFLOW_TOKEN = ORIGINAL_ENV;
  });

  it('prefers an explicit token argument over everything else', async () => {
    process.env.GITHUB_WORKFLOW_TOKEN = 'env-token';
    const { resolveGithubToken } = await import('../../src/lib/token.js');
    expect(resolveGithubToken('explicit-token')).toBe('explicit-token');
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('uses GITHUB_WORKFLOW_TOKEN when set', async () => {
    process.env.GITHUB_WORKFLOW_TOKEN = 'env-token';
    const { resolveGithubToken } = await import('../../src/lib/token.js');
    expect(resolveGithubToken()).toBe('env-token');
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('falls back to `gh auth token` when the env var is empty', async () => {
    execSyncMock.mockReturnValue('gh-cli-token\n');
    const { resolveGithubToken } = await import('../../src/lib/token.js');
    expect(resolveGithubToken()).toBe('gh-cli-token');
    expect(execSyncMock).toHaveBeenCalledWith('gh auth token', expect.anything());
  });

  it('returns undefined (not throw) when gh is unavailable or unauthenticated', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('gh: command not found');
    });
    const { resolveGithubToken } = await import('../../src/lib/token.js');
    expect(resolveGithubToken()).toBeUndefined();
  });

  it('caches the gh CLI fallback across calls within the same process', async () => {
    execSyncMock.mockReturnValue('gh-cli-token\n');
    const { resolveGithubToken } = await import('../../src/lib/token.js');
    resolveGithubToken();
    resolveGithubToken();
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });
});
