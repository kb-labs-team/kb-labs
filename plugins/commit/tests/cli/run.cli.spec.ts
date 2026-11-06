import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../src/core/index.js', () => ({
  generateCommitPlan: vi.fn(),
  savePlan: vi.fn().mockResolvedValue(undefined),
  hasChanges: vi.fn().mockReturnValue(true),
  getGitStatus: vi.fn().mockResolvedValue({ staged: [], unstaged: [], untracked: [] }),
  applyCommitPlan: vi.fn(),
  pushCommits: vi.fn(),
  saveToHistory: vi.fn().mockResolvedValue(undefined),
  clearPlan: vi.fn().mockResolvedValue(undefined),
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
      update: vi.fn(),
    })),
    useConfig: vi.fn().mockResolvedValue({}),
    findRepoRoot: vi.fn().mockResolvedValue('/project'),
    useLLM: vi.fn().mockReturnValue(null),
  };
});

vi.mock('../../src/rest/handlers/scope-resolver.js', () => ({
  resolveScopePath: vi.fn((_cwd: string, _scope: string) => _cwd),
}));

import { generateCommitPlan, applyCommitPlan, hasChanges, getGitStatus, savePlan, saveToHistory, clearPlan } from '../../src/core/index.js';
import { AdapterCredentialsMissingError, AdapterUnavailableError, findRepoRoot } from '@kb-labs/sdk';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import type { CommitFlags, GenerateFlags } from '../../src/contracts/flags.js';
import runCommand from '../../src/cli/commands/run.js';
import generateCommand from '../../src/cli/commands/generate.js';

function runInput(flags: Partial<CommitFlags> = {}) {
  return mockCLIInput<CommitFlags>({ flags: {
    scope: 'root', json: false, 'dry-run': false, 'with-push': false, 'allow-secrets': false, yes: false, ...flags,
  } });
}

function generateInput(flags: Partial<GenerateFlags> = {}): GenerateFlags {
  return { scope: 'root', json: false, 'allow-secrets': false, yes: false, ...flags };
}

const mockPlan = {
  commits: [
    {
      id: 'c1',
      type: 'feat',
      scope: 'auth',
      message: 'add login flow',
      files: ['src/auth.ts', 'src/login.ts'],
    },
    {
      id: 'c2',
      type: 'fix',
      scope: undefined,
      message: 'correct typo',
      files: ['README.md'],
    },
  ],
  metadata: {
    totalFiles: 3,
    totalCommits: 2,
    llmUsed: false,
    escalated: false,
    tokensUsed: 0,
  },
};

const mockApplyResult = {
  success: true,
  errors: [],
  appliedCommits: [
    { groupId: 'c1', sha: 'abc1234', message: 'feat(auth): add login flow' },
    { groupId: 'c2', sha: 'def5678', message: 'fix: correct typo' },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getGitStatus).mockResolvedValue({ staged: [], unstaged: [], untracked: [] } as never);
  vi.mocked(hasChanges).mockReturnValue(true);
  vi.mocked(generateCommitPlan).mockResolvedValue(mockPlan as never);
  vi.mocked(savePlan).mockResolvedValue(undefined);
  vi.mocked(applyCommitPlan).mockResolvedValue(mockApplyResult as never);
  vi.mocked(saveToHistory).mockResolvedValue(undefined);
  vi.mocked(clearPlan).mockResolvedValue(undefined);
});

function createRunContext(ui: ReturnType<typeof createCapturedUI>['ui']) {
  return createMockContext({
    ui,
    cwd: '/project',
    platformConfig: { platform: { adapters: { llm: '@kb-labs/adapter-fixture' } } },
  });
}

describe('commit:commit (run)', () => {
  it('CR-01: applies commits — successful result and success message', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createRunContext(ui);

    const result = await runCommand.execute(ctx as never, runInput());

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(vi.mocked(applyCommitPlan)).toHaveBeenCalledOnce();
  });

  // case: S-160.4
  it('CR-02: no changes — successful no-op result', async () => {
    vi.mocked(hasChanges).mockReturnValue(false);

    const { ui, captured } = createCapturedUI();
    const ctx = createRunContext(ui);

    const result = await runCommand.execute(ctx as never, runInput());

    expect(result).toMatchObject({ plan: { commits: [] }, applied: false, pushed: false, commits: [] });
    expect(captured.success[0]?.message).toContain('No changes to commit');
    expect(vi.mocked(applyCommitPlan)).not.toHaveBeenCalled();
    expect(vi.mocked(generateCommitPlan)).not.toHaveBeenCalled();
  });

  it('CR-03: apply fails — failed result and error shown', async () => {
    vi.mocked(applyCommitPlan).mockResolvedValue({
      success: false,
      errors: ['Merge conflict'],
      appliedCommits: [],
    } as never);

    const { ui, captured } = createCapturedUI();
    const ctx = createRunContext(ui);

    const result = await runCommand.execute(ctx as never, mockCLIInput({ flags: {} }));

    expect('ok' in result && result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('CR-04: --json outputs CommitRunOutput', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createRunContext(ui);

    const result = await runCommand.execute(ctx as never, runInput({ json: true }));

    const out = result as Record<string, unknown>;
    expect(out.applied).toBe(true);
    expect(Array.isArray(out.commits)).toBe(true);
  });

  it('CR-05: --dry-run returns a preview without changing HEAD, index, or working tree', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'commit-dry-run-'));
    try {
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test User']);
      execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
      await writeFile(path.join(repo, 'tracked.txt'), 'committed\n');
      execFileSync('git', ['-C', repo, 'add', 'tracked.txt']);
      execFileSync('git', ['-C', repo, 'commit', '-qm', 'test: initial']);
      await writeFile(path.join(repo, 'tracked.txt'), 'staged change\n');
      execFileSync('git', ['-C', repo, 'add', 'tracked.txt']);
      await writeFile(path.join(repo, 'tracked.txt'), 'working tree change\n');
      await mkdir(path.join(repo, 'untracked-dir'));
      await writeFile(path.join(repo, 'untracked-dir', 'new.txt'), 'untracked\n');

      vi.mocked(findRepoRoot).mockResolvedValue(repo);
      const gitSnapshot = () => ({
        head: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        index: execFileSync('git', ['-C', repo, 'diff', '--cached', '--binary'], { encoding: 'utf8' }),
        worktree: execFileSync('git', ['-C', repo, 'diff', '--binary'], { encoding: 'utf8' }),
        status: execFileSync('git', ['-C', repo, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }),
      });
      const before = gitSnapshot();
      const { ui, captured } = createCapturedUI();
      const result = await runCommand.execute(createRunContext(ui) as never, runInput({ 'dry-run': true, json: true }));

      expect(result).not.toHaveProperty('ok');
      expect(gitSnapshot()).toEqual(before);
      expect(generateCommitPlan).toHaveBeenCalledOnce();
      expect(applyCommitPlan).not.toHaveBeenCalled();
      expect(savePlan).not.toHaveBeenCalled();
      expect(saveToHistory).not.toHaveBeenCalled();
      expect(clearPlan).not.toHaveBeenCalled();
      expect(result).toMatchObject({ plan: mockPlan, applied: false, pushed: false, commits: [] });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('CR-06: --dry-run with no changes — returns an empty preview in the same result shape', async () => {
    vi.mocked(hasChanges).mockReturnValue(false);

    const { ui, captured } = createCapturedUI();
    const ctx = createRunContext(ui);

    const result = await runCommand.execute(ctx as never, runInput({ 'dry-run': true, json: true }));

    expect(result).not.toHaveProperty('ok');
    expect(vi.mocked(applyCommitPlan)).not.toHaveBeenCalled();
    expect(result).toMatchObject({ plan: { commits: [] }, applied: false, pushed: false, commits: [] });
  });

  // case: S-160.4
  it('CR-07: no changes without --dry-run — returns a successful empty result', async () => {
    vi.mocked(hasChanges).mockReturnValue(false);

    const { ui, captured } = createCapturedUI();
    const result = await runCommand.execute(createRunContext(ui) as never, runInput({ json: true }));

    expect(result).toMatchObject({ plan: { commits: [] }, applied: false, pushed: false, commits: [] });
    expect(applyCommitPlan).not.toHaveBeenCalled();
    expect(generateCommitPlan).not.toHaveBeenCalled();
  });

  // case: S-160.2
  it('missing LLM adapter fails with the typed adapter error', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    await expect(runCommand.execute(ctx as never, runInput({ 'dry-run': true })))
      .rejects.toBeInstanceOf(AdapterUnavailableError);
    expect(generateCommitPlan).not.toHaveBeenCalled();
    expect(applyCommitPlan).not.toHaveBeenCalled();
  });
});

describe('commit:generate (adapter errors)', () => {
  it('returns the typed adapter envelope in JSON mode when the LLM is unconfigured', async () => {
    vi.mocked(generateCommitPlan).mockRejectedValueOnce(new AdapterUnavailableError('llm'));

    const { ui, captured } = createCapturedUI();
    const ctx = createRunContext(ui);
    const result = await generateCommand.execute(ctx as never, generateInput({ json: true }));

    if (!('ok' in result) || result.ok) throw new Error('Expected generate failure result');
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_ADAPTER_NOT_CONFIGURED',
        message: expect.stringContaining('not configured'),
        hint: expect.any(String),
        details: { service: 'llm' },
      },
    });
  });

  // case: S-054.5
  it('returns one typed missing OpenAI key envelope through the shared result boundary', async () => {
    vi.mocked(generateCommitPlan).mockRejectedValueOnce(new AdapterCredentialsMissingError(
      'llm', 'OPENAI_API_KEY', 'platform.adapterOptions.llm.apiKey',
    ));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({
      ui,
      cwd: '/project',
      platformConfig: { platform: { adapters: { llm: '@kb-labs/adapters-openai' } } },
    });
    const result = await generateCommand.execute(ctx as never, generateInput({ json: true }));

    if (!('ok' in result) || result.ok) throw new Error('Expected generate failure result');
    expect(captured.json).toHaveLength(0);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_ADAPTER_CREDENTIALS_MISSING',
        message: expect.stringContaining('OPENAI_API_KEY'),
        hint: expect.stringContaining("kb config set --scope platform platform.adapterOptions.llm.apiKey '${OPENAI_API_KEY}' --allow-missing-env"),
      },
    });
    expect(result.error?.hint).toContain('No request was sent');
    expect(JSON.stringify(result)).not.toContain('test-secret-value');
    expect(captured.errors).toHaveLength(0);
    expect(captured.infos).toHaveLength(0);
  });

  // case: S-054.8
  it('returns a typed missing OpenAI key envelope in JSON mode when OpenAI is bound', async () => {
    vi.mocked(generateCommitPlan).mockRejectedValueOnce(new AdapterCredentialsMissingError(
      'llm', 'OPENAI_API_KEY', 'platform.adapterOptions.llm.apiKey',
    ));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({
      ui,
      cwd: '/project',
      platformConfig: { platform: { adapters: { llm: '@kb-labs/adapters-openai' } } },
    });
    const result = await generateCommand.execute(ctx as never, generateInput({ json: true }));

    if (!('ok' in result) || result.ok) throw new Error('Expected generate failure result');
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_ADAPTER_CREDENTIALS_MISSING',
        message: expect.stringContaining('OPENAI_API_KEY'),
        hint: expect.stringContaining("kb config set --scope platform platform.adapterOptions.llm.apiKey '${OPENAI_API_KEY}' --allow-missing-env"),
      },
    });
    expect(result.error?.hint).toContain('No request was sent');
  });
});
