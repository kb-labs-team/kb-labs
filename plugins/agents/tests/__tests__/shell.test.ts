import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import { createShellExecTool } from '../../src/tools/tools/execution/shell.js';
import type { ToolContext } from '../../src/tools/types.js';
import type { ToolResult } from '@kb-labs/agents/contracts';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

function ctx(workingDir = '/test/project'): ToolContext {
  return { workingDir };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('shell_exec', () => {
  it('returns success with output', async () => {
    mockExecSync.mockReturnValue('hello world\n');
    const tool = createShellExecTool(ctx());

    const result = await tool.executor({ command: 'echo hello world' }) as ToolResult;

    expect(result.success).toBe(true);
    expect(result.output).toContain('hello world');
  });

  it('includes cwd in output', async () => {
    mockExecSync.mockReturnValue('');
    const tool = createShellExecTool(ctx('/my/project'));

    const result = await tool.executor({ command: 'pwd' }) as ToolResult;

    expect(result.output).toContain('/my/project');
  });

  it('uses working directory as cwd by default', async () => {
    mockExecSync.mockReturnValue('');
    const tool = createShellExecTool(ctx('/root'));

    await tool.executor({ command: 'ls' });

    // execSync options — the second argument is ExecSyncOptionsWithStringEncoding,
    // but our mock doesn't enforce it, so we cast to access cwd
    const opts = mockExecSync.mock.calls[0]![1] as { cwd?: string };
    expect(opts.cwd).toBe('/root');
  });

  it('resolves relative cwd from workingDir', async () => {
    mockExecSync.mockReturnValue('');
    const tool = createShellExecTool(ctx('/root'));

    await tool.executor({ command: 'ls', cwd: 'sub/dir' });

    const opts = mockExecSync.mock.calls[0]![1] as { cwd?: string };
    expect(opts.cwd).toBe('/root/sub/dir');
  });

  it('rejects cwd outside workingDir', async () => {
    const tool = createShellExecTool(ctx('/root'));

    const result = await tool.executor({ command: 'ls', cwd: '../../etc' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.errorDetails?.code).toBe('INVALID_CWD');
  });

  it('returns placeholder text when command produces no output', async () => {
    mockExecSync.mockReturnValue('');
    const tool = createShellExecTool(ctx());

    const result = await tool.executor({ command: 'touch /tmp/x' }) as ToolResult;

    expect(result.success).toBe(true);
    expect(result.output).toContain('no output');
  });

  it('returns SHELL_TIMEOUT on timeout', async () => {
    const err = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    mockExecSync.mockImplementation(() => { throw err; });
    const tool = createShellExecTool(ctx());

    const result = await tool.executor({ command: 'sleep 100' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.errorDetails?.code).toBe('SHELL_TIMEOUT');
    expect(result.errorDetails?.retryable).toBe(true);
  });

  it('returns COMMAND_NOT_FOUND on exit code 127', async () => {
    const err = Object.assign(new Error(''), {
      status: 127,
      stderr: Buffer.from('command not found: nonexistent'),
      stdout: Buffer.from(''),
    });
    mockExecSync.mockImplementation(() => { throw err; });
    const tool = createShellExecTool(ctx());

    const result = await tool.executor({ command: 'nonexistent' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.errorDetails?.code).toBe('COMMAND_NOT_FOUND');
    expect(result.errorDetails?.retryable).toBe(false);
  });

  it('returns PERMISSION_DENIED on exit code 126', async () => {
    const err = Object.assign(new Error(''), {
      status: 126,
      stderr: Buffer.from('permission denied'),
      stdout: Buffer.from(''),
    });
    mockExecSync.mockImplementation(() => { throw err; });
    const tool = createShellExecTool(ctx());

    const result = await tool.executor({ command: './script.sh' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.errorDetails?.code).toBe('PERMISSION_DENIED');
    expect(result.errorDetails?.retryable).toBe(false);
  });

  it('returns NON_ZERO_EXIT for generic failures', async () => {
    const err = Object.assign(new Error(''), {
      status: 1,
      stderr: Buffer.from('some error'),
      stdout: Buffer.from(''),
    });
    mockExecSync.mockImplementation(() => { throw err; });
    const tool = createShellExecTool(ctx());

    const result = await tool.executor({ command: 'false' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.errorDetails?.code).toBe('NON_ZERO_EXIT');
    expect(result.errorDetails?.retryable).toBe(true);
  });
});
