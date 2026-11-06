import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SystemPromptBuilder, loadProjectInstructions, clearSystemPromptCache } from '../../src/core/prompt/system-prompt-builder';
import type { SystemPromptInput } from '../../src/core/prompt/system-prompt-builder';
import * as fs from 'node:fs';

vi.mock('node:fs');

function makeInput(overrides: Partial<SystemPromptInput> = {}): SystemPromptInput {
  return {
    workingDir: '/tmp/test',
    responseMode: 'auto',
    isSubAgent: false,
    ...overrides,
  };
}

describe('SystemPromptBuilder', () => {
  const builder = new SystemPromptBuilder();

  // Clear cache between tests to avoid stale static prompt
  beforeEach(() => clearSystemPromptCache());

  it('builds a prompt containing core rules', async () => {
    const prompt = await builder.build(makeInput());
    expect(prompt).toContain('Core rules');
    expect(prompt).toContain('NEVER answer from memory');
  });

  it('includes delegation section for main agents', async () => {
    const prompt = await builder.build(makeInput({ isSubAgent: false }));
    expect(prompt).toContain('task_submit');
    expect(prompt).toContain('Delegation');
  });

  it('excludes delegation section for sub-agents', async () => {
    const prompt = await builder.build(makeInput({ isSubAgent: true }));
    expect(prompt).not.toContain('task_submit');
  });

  it('includes session continuity note when session present', async () => {
    const prompt = await builder.build(makeInput({
      sessionId: 'sess-1',
      sessionRootDir: '/tmp',
    }));
    expect(prompt).toContain('Session continuity');
  });

  it('includes workspace section when discovery present', async () => {
    const prompt = await builder.build(makeInput({
      workspaceDiscovery: {
        rootDir: '/project',
        repos: [
          { name: 'core', path: '/project/packages/core', reasons: ['tsconfig'], packages: [], dirs: [] },
          { name: 'cli', path: '/project/packages/cli', reasons: ['package.json'], packages: [], dirs: [] },
        ],
      },
    }));
    expect(prompt).toContain('Workspace');
    expect(prompt).toContain('packages/core');
  });

  it('does not include workspace section when no repos', async () => {
    const prompt = await builder.build(makeInput({
      workspaceDiscovery: { rootDir: '/project', repos: [] },
    }));
    expect(prompt).not.toContain('Workspace (');
  });

  it('includes memory context when memory provided', async () => {
    const memory = {
      getContext: vi.fn().mockResolvedValue('some memory context'),
      getRecent: vi.fn().mockResolvedValue([]),
      add: vi.fn(),
    } as any;

    const prompt = await builder.build(makeInput({ memory }));
    expect(prompt).toContain('Memory Context');
    expect(prompt).toContain('some memory context');
  });

  it('static prompt is cached between builds', async () => {
    const prompt1 = await builder.build(makeInput());
    const prompt2 = await builder.build(makeInput());
    // Both should contain same static core
    expect(prompt1).toContain('Core rules');
    expect(prompt2).toContain('Core rules');
  });
});

describe('loadProjectInstructions', () => {
  it('returns null when no instruction files exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadProjectInstructions('/tmp')).toBeNull();
  });

  it('returns content of first found instruction file', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).endsWith('AGENT.md')
    );
    vi.mocked(fs.readFileSync).mockReturnValue('# Agent instructions');

    expect(loadProjectInstructions('/tmp')).toBe('# Agent instructions');
  });

  it('skips empty files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValueOnce('   ').mockReturnValueOnce('real content');

    expect(loadProjectInstructions('/tmp')).toBe('real content');
  });
});
