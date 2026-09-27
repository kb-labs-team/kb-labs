import { describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { EXTERNAL_HARNESS_IDS, type ExternalHarnessId } from '@kb-labs/agent-contracts';
import { getExternalHarnessAdapter } from './index.js';

describe('external harness adapter registry', () => {
  it('registers each shared harness identifier', () => {
    for (const id of EXTERNAL_HARNESS_IDS) {
      expect(getExternalHarnessAdapter(id)).toBeDefined();
    }
  });

  it.each([
    ['codex-cli', 'workspace-write'],
    ['claude-code', 'acceptEdits'],
  ] as Array<[ExternalHarnessId, string]>)('builds a local launch for %s', (id, expectedMode) => {
    const launch = getExternalHarnessAdapter(id).launch({
      harness: id,
      workingDir: '/work/repo',
      prompt: 'Do the assigned task.',
      preset: 'execute',
      maxIterations: 24,
    });

    expect(launch.args).toContain(expectedMode);
    expect(launch.args).toContain('Do the assigned task.');
    expect(launch.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(launch.args).not.toContain('--dangerously-skip-permissions');
  });

  it('maps research to a read-only execution mode', () => {
    const codex = getExternalHarnessAdapter('codex-cli').launch({
      harness: 'codex-cli', workingDir: '/work/repo', prompt: 'Read only.', preset: 'research', maxIterations: 5,
    });
    const claude = getExternalHarnessAdapter('claude-code').launch({
      harness: 'claude-code', workingDir: '/work/repo', prompt: 'Read only.', preset: 'research', maxIterations: 5,
    });

    expect(codex.args).toContain('read-only');
    expect(claude.args).toContain('plan');
  });

  it('configures Codex with the task lease through a per-process environment variable', async () => {
    const adapter = getExternalHarnessAdapter('codex-cli');
    const prepared = await adapter.prepareMcpConfig!({
      harness: 'codex-cli', workingDir: '/work/repo', prompt: 'task', preset: 'execute', maxIterations: 24,
    }, { url: 'http://127.0.0.1:7779/api/v1/mcp', accessToken: 'child-scoped-lease' });

    expect(prepared.args.join(' ')).toContain('mcp_servers.kb_platform.url');
    expect(prepared.args.join(' ')).toContain('bearer_token_env_var');
    expect(prepared.args.join(' ')).not.toContain('child-scoped-lease');
    expect(prepared.env).toEqual({ KB_AGENT_MCP_TOKEN: 'child-scoped-lease' });
  });

  it('writes Claude MCP config to a private temporary file and cleans it up', async () => {
    const adapter = getExternalHarnessAdapter('claude-code');
    const prepared = await adapter.prepareMcpConfig!({
      harness: 'claude-code', workingDir: '/work/repo', prompt: 'task', preset: 'execute', maxIterations: 24,
    }, { url: 'http://127.0.0.1:7779/api/v1/mcp', accessToken: 'child-scoped-lease' });
    const configPath = prepared.args[prepared.args.indexOf('--mcp-config') + 1]!;
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const fileStat = await stat(configPath);

    expect(prepared.args).toContain('--strict-mcp-config');
    expect(config.mcpServers.kb_platform.headers.Authorization).toBe('Bearer child-scoped-lease');
    expect(fileStat.mode & 0o777).toBe(0o600);
    await prepared.cleanup?.();
    await expect(stat(configPath)).rejects.toThrow();
  });

  it('normalizes Codex JSONL final messages and usage', () => {
    const adapter = getExternalHarnessAdapter('codex-cli');
    expect(adapter.parseLine(JSON.stringify({
      type: 'item.completed', item: { type: 'agent_message', text: 'Done.' },
    }))).toMatchObject({ summary: 'Done.', activity: { type: 'message', action: 'Assistant response' } });
    expect(adapter.parseLine(JSON.stringify({
      type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 4 },
    }))).toMatchObject({ iterations: 1, tokensUsed: 14, activity: { type: 'status' } });
  });

  it('normalizes Claude result and failure events', () => {
    const adapter = getExternalHarnessAdapter('claude-code');
    expect(adapter.parseLine(JSON.stringify({
      type: 'result', result: 'Review complete.', usage: { input_tokens: 8, output_tokens: 3 },
    }))).toMatchObject({ summary: 'Review complete.', iterations: 1, tokensUsed: 11, activity: { type: 'status' } });
    expect(adapter.parseLine(JSON.stringify({ type: 'result', result: 'Denied', is_error: true })))
      .toMatchObject({ error: 'Denied' });
  });
});
