import type { ExternalHarnessAdapter } from '../types.js';

export const codexCliAdapter: ExternalHarnessAdapter = {
  launch: ({ workingDir, prompt, preset }) => ({
    command: 'codex',
    args: [
      'exec', '--json', '--ephemeral', '--sandbox',
      preset === 'research' ? 'read-only' : 'workspace-write',
      '--cd', workingDir, prompt,
    ],
  }),
  async prepareMcpConfig(_input, access) {
    return {
      args: [
        '--config', `mcp_servers.kb_platform.url=${JSON.stringify(access.url)}`,
        '--config', 'mcp_servers.kb_platform.bearer_token_env_var="KB_AGENT_MCP_TOKEN"',
      ],
      env: { KB_AGENT_MCP_TOKEN: access.accessToken },
    };
  },
  parseLine(line) {
    const event = parseJsonRecord(line);
    if (!event) { return {}; }
    if (event.type === 'turn.failed') {
      return {
        error: isRecord(event.error) && typeof event.error.message === 'string'
          ? event.error.message
          : 'turn failed',
        activity: { type: 'error', action: 'Codex turn failed', detail: isRecord(event.error) && typeof event.error.message === 'string' ? event.error.message : undefined },
      };
    }
    if (event.type === 'turn.started') { return { activity: { type: 'progress', action: 'Turn started' } }; }
    if ((event.type === 'item.started' || event.type === 'item.completed') && isRecord(event.item)) {
      const item = event.item;
      if (item.type === 'command_execution') {
        const command = typeof item.command === 'string' ? item.command : 'Command execution';
        const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : undefined;
        return { activity: { type: 'tool', action: event.type === 'item.started' ? command : `Finished: ${command}`, ...(output ? { detail: output.slice(0, 2_000) } : {}) } };
      }
      if (item.type === 'agent_message' && event.type === 'item.completed' && typeof item.text === 'string') {
        return { summary: item.text, activity: { type: 'message', action: 'Assistant response', detail: item.text.slice(0, 2_000) } };
      }
      if (item.type === 'reasoning') { return { activity: { type: 'thinking', action: 'Reasoning' } }; }
    }
    if (event.type === 'turn.completed') {
      const usage = isRecord(event.usage) ? event.usage : undefined;
      return {
        iterations: 1,
        tokensUsed: numeric(usage?.input_tokens) + numeric(usage?.output_tokens),
        activity: { type: 'status', action: 'Turn completed' },
      };
    }
    return {};
  },
};

function parseJsonRecord(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
