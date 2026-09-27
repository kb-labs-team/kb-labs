import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExternalHarnessAdapter } from '../types.js';

export const claudeCodeAdapter: ExternalHarnessAdapter = {
  launch: ({ prompt, preset, maxIterations }) => ({
    command: 'claude',
    args: [
      '--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--permission-mode', preset === 'research' ? 'plan' : 'acceptEdits',
      '--permission-prompts', 'none', '--max-turns', String(Math.max(1, maxIterations)), prompt,
    ],
  }),
  async prepareMcpConfig(_input, access) {
    const directory = await mkdtemp(join(tmpdir(), 'kb-agents-mcp-'));
    const path = join(directory, 'mcp.json');
    try {
      await writeFile(path, JSON.stringify({
        mcpServers: {
          kb_platform: {
            type: 'http',
            url: access.url,
            headers: { Authorization: `Bearer ${access.accessToken}` },
          },
        },
      }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return {
      args: ['--strict-mcp-config', '--mcp-config', path],
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  },
  parseLine(line) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return {};
    }
    if (!isRecord(value)) { return {}; }
    if (value.type === 'assistant' && isRecord(value.message) && Array.isArray(value.message.content)) {
      const block = value.message.content.find((item) => isRecord(item) && (item.type === 'tool_use' || item.type === 'text' || item.type === 'thinking'));
      if (!isRecord(block)) { return { activity: { type: 'progress', action: 'Assistant updated' } }; }
      if (block.type === 'tool_use') {
        const toolName = typeof block.name === 'string' ? block.name : 'Tool call';
        const input = isRecord(block.input) ? JSON.stringify(block.input) : undefined;
        return { activity: { type: 'tool', action: toolName, ...(input ? { detail: input.slice(0, 2_000) } : {}) } };
      }
      if (block.type === 'thinking') { return { activity: { type: 'thinking', action: 'Reasoning' } }; }
      const text = typeof block.text === 'string' ? block.text : '';
      return { activity: { type: 'message', action: 'Assistant response', ...(text ? { detail: text.slice(0, 2_000) } : {}) } };
    }
    if (value.type === 'user' && isRecord(value.message) && Array.isArray(value.message.content)) {
      const result = value.message.content.find((item) => isRecord(item) && item.type === 'tool_result');
      if (isRecord(result)) {
        const output = typeof result.content === 'string' ? result.content : '';
        return { activity: { type: 'tool', action: 'Tool result', ...(output ? { detail: output.slice(0, 2_000) } : {}) } };
      }
    }
    if (value.type === 'result') {
    const usage = isRecord(value.usage) ? value.usage : undefined;
    const summary = typeof value.result === 'string' ? value.result : undefined;
    return {
      summary,
      iterations: 1,
      tokensUsed: numeric(usage?.input_tokens) + numeric(usage?.output_tokens),
      ...(value.is_error === true ? { error: summary || 'Claude Code reported an error' } : {}),
      activity: { type: value.is_error === true ? 'error' : 'status', action: value.is_error === true ? 'Claude Code failed' : 'Turn completed', ...(summary ? { detail: summary.slice(0, 2_000) } : {}) },
    };
    }
    if (value.type === 'content_block_delta' && isRecord(value.delta) && typeof value.delta.text === 'string') {
      return { activity: { type: 'message', action: 'Assistant response', detail: value.delta.text.slice(0, 2_000) } };
    }
    if (value.type === 'system' || value.type === 'stream_event') { return { activity: { type: 'progress', action: String(value.subtype ?? value.type) } }; }
    return {};
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
