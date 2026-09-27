import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { ExternalHarnessId, SubAgentPreset } from '@kb-labs/agent-contracts';
import { getExternalHarnessAdapter } from '@kb-labs/agent-harnesses';
import { buildHarnessPrompt, runExternalHarness } from '../external-harness.js';

const baseInput = {
  task: 'Implement the requested change',
  workingDir: '/work/repo',
  maxIterations: 24,
  preset: 'execute' as SubAgentPreset,
};

describe('external harness adapters', () => {
  it('passes project instructions as plain task context without interpreting them', () => {
    const prompt = buildHarnessPrompt('Review the implementation', 'Prefer Claude for independent reviews.');

    expect(prompt).toContain('# Project instructions\nPrefer Claude for independent reviews.');
    expect(prompt).toContain('# Assigned task\nReview the implementation');
  });

  it.each([
    ['codex-cli', ['exec', '--json', '--ephemeral', '--sandbox', 'workspace-write', '--cd', '/work/repo']],
    ['claude-code', ['--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', 'acceptEdits']],
  ] as Array<[ExternalHarnessId, string[]]>)('builds a bounded local launch for %s', (harness, expectedArgs) => {
    const launch = getExternalHarnessAdapter(harness).launch({ ...baseInput, harness, prompt: 'task prompt' });

    expect(launch.args).toEqual(expect.arrayContaining(expectedArgs));
    expect(launch.args).toContain('task prompt');
    expect(launch.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(launch.args).not.toContain('--dangerously-skip-permissions');
  });

  it('uses read-only modes for research harness tasks', () => {
    const codex = getExternalHarnessAdapter('codex-cli').launch({ ...baseInput, harness: 'codex-cli', preset: 'research', prompt: 'task' });
    const claude = getExternalHarnessAdapter('claude-code').launch({ ...baseInput, harness: 'claude-code', preset: 'research', prompt: 'task' });

    expect(codex.args).toContain('read-only');
    expect(claude.args).toContain('plan');
  });

  it('normalizes Codex JSONL completion and usage', () => {
    expect(getExternalHarnessAdapter('codex-cli').parseLine(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Implemented and tested.' },
    }))).toMatchObject({ summary: 'Implemented and tested.', activity: { type: 'message' } });
    expect(getExternalHarnessAdapter('codex-cli').parseLine(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 20, output_tokens: 7 },
    }))).toMatchObject({ iterations: 1, tokensUsed: 27, activity: { type: 'status' } });
  });

  it('normalizes Claude result and failures', () => {
    expect(getExternalHarnessAdapter('claude-code').parseLine(JSON.stringify({
      type: 'result',
      result: 'Review complete.',
      usage: { input_tokens: 15, output_tokens: 6 },
    }))).toMatchObject({ summary: 'Review complete.', iterations: 1, tokensUsed: 21, activity: { type: 'status' } });
    expect(getExternalHarnessAdapter('claude-code').parseLine(JSON.stringify({ type: 'result', result: 'Denied', is_error: true })))
      .toMatchObject({ error: 'Denied' });
  });

  it('runs a harness process and returns only its normalized final response', async () => {
    const child = createFakeChild();
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess);
    const output = `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } })}\n${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9, output_tokens: 4 } })}`;
    queueMicrotask(() => {
      child.stdout.end(output);
      child.emit('close', 0, null);
    });

    const activities: string[] = [];
    const result = await runExternalHarness({
      ...baseInput,
      harness: 'codex-cli',
      onActivity: (activity) => activities.push(activity.action),
    }, spawnProcess as never);

    expect(spawnProcess).toHaveBeenCalledWith('codex', expect.any(Array), expect.objectContaining({ cwd: '/work/repo' }));
    expect(result).toEqual({ summary: 'Done.', iterations: 1, tokensUsed: 13 });
    expect(activities).toContain('Assistant response');
    expect(activities).toContain('Turn completed');
  });

  it('passes only the child lease to the harness and revokes temporary config after success', async () => {
    const child = createFakeChild();
    const originalParentToken = process.env.KB_MCP_TOKEN;
    const originalJwtSecret = process.env.GATEWAY_JWT_SECRET;
    const originalInternalSecret = process.env.GATEWAY_INTERNAL_SECRET;
    process.env.KB_MCP_TOKEN = 'parent-user-token-must-not-leak';
    process.env.GATEWAY_JWT_SECRET = 'platform-signing-secret';
    process.env.GATEWAY_INTERNAL_SECRET = 'platform-dispatch-secret';
    let capturedArgs: string[] = [];
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawnProcess = vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      capturedArgs = args;
      capturedEnv = options.env;
      const output = `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Used kb_platform for host-agent__workspace_status.' } })}\n${JSON.stringify({ type: 'turn.completed' })}`;
      queueMicrotask(() => {
        child.stdout.end(output);
        child.emit('close', 0, null);
      });
      return child as unknown as ChildProcess;
    });

    try {
      const result = await runExternalHarness({
        ...baseInput, harness: 'codex-cli',
        mcpAccess: { url: 'http://127.0.0.1:7779/api/v1/mcp', accessToken: 'child-only-scoped-token' },
        mcpTools: ['host-agent__workspace_status'],
      }, spawnProcess as never);

      expect(result.summary).toContain('host-agent__workspace_status');
      expect(capturedArgs.join(' ')).toContain('mcp_servers.kb_platform.url');
      expect(capturedArgs.join(' ')).not.toContain('child-only-scoped-token');
      expect(capturedEnv?.KB_AGENT_MCP_TOKEN).toBe('child-only-scoped-token');
      expect(capturedEnv?.KB_MCP_TOKEN).toBeUndefined();
      expect(capturedEnv?.GATEWAY_JWT_SECRET).toBeUndefined();
      expect(capturedEnv?.GATEWAY_INTERNAL_SECRET).toBeUndefined();
      expect(capturedArgs.at(-1)).toContain('host-agent__workspace_status');
    } finally {
      if (originalParentToken === undefined) { delete process.env.KB_MCP_TOKEN; }
      else { process.env.KB_MCP_TOKEN = originalParentToken; }
      if (originalJwtSecret === undefined) { delete process.env.GATEWAY_JWT_SECRET; }
      else { process.env.GATEWAY_JWT_SECRET = originalJwtSecret; }
      if (originalInternalSecret === undefined) { delete process.env.GATEWAY_INTERNAL_SECRET; }
      else { process.env.GATEWAY_INTERNAL_SECRET = originalInternalSecret; }
    }
  });

  it('removes Claude temporary MCP config when the harness exits unsuccessfully', async () => {
    const child = createFakeChild();
    let configPath = '';
    const spawnProcess = vi.fn((_command: string, args: string[]) => {
      configPath = args[args.indexOf('--mcp-config') + 1] ?? '';
      queueMicrotask(() => {
        child.stderr.end('harness failed');
        child.emit('close', 1, null);
      });
      return child as unknown as ChildProcess;
    });

    await expect(runExternalHarness({
      ...baseInput, harness: 'claude-code',
      mcpAccess: { url: 'http://127.0.0.1:7779/api/v1/mcp', accessToken: 'child-only-scoped-token' },
      mcpTools: ['host-agent__workspace_status'],
    }, spawnProcess as never)).rejects.toThrow('harness failed');
    await expect(stat(configPath)).rejects.toThrow();
  });

  it('settles cancellation and cleans up MCP config when the child never closes', async () => {
    const child = createFakeChild();
    child.kill = vi.fn(() => true);
    const abortController = new AbortController();
    let configPath = '';
    const spawnProcess = vi.fn((_command: string, args: string[]) => {
      configPath = args[args.indexOf('--mcp-config') + 1] ?? '';
      // Abort after spawn; aborting immediately would only exercise the
      // pre-launch cancellation path while the async MCP config is prepared.
      abortController.abort();
      return child as unknown as ChildProcess;
    });

    const promise = runExternalHarness({
      ...baseInput, harness: 'claude-code', signal: abortController.signal,
      mcpAccess: { url: 'http://127.0.0.1:7779/api/v1/mcp', accessToken: 'child-only-scoped-token' },
      mcpTools: ['host-agent__workspace_status'],
    }, spawnProcess as never);

    await expect(promise).rejects.toThrow('cancelled');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(stat(configPath)).rejects.toThrow();
  });

  it('terminates a harness process when the parent cancels', async () => {
    const child = createFakeChild();
    const abortController = new AbortController();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      return true;
    });
    const promise = runExternalHarness({ ...baseInput, harness: 'claude-code', signal: abortController.signal }, (() => child) as never);
    abortController.abort();

    await expect(promise).rejects.toThrow('cancelled');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

function createFakeChild(): ChildProcess & { stdout: PassThrough; stderr: PassThrough } {
  const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}
