import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPAgentServer } from '../../src/mcp/server/mcp-agent-server.js';
import type { AgentServerCallbacks, AgentSession } from '../../src/mcp/server/mcp-agent-server.js';

// ── MCP SDK Server mock ────────────────────────────────────────────────

const mockHandlers = new Map<string, (req: unknown) => Promise<unknown>>();

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => {
  class Server {
    setRequestHandler(schema: { method: string }, handler: (req: unknown) => Promise<unknown>) {
      mockHandlers.set(schema.method ?? JSON.stringify(schema), handler);
    }

    connect = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
  }
  return { Server };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: { method: 'tools/call' },
  ListToolsRequestSchema: { method: 'tools/list' },
  ListResourcesRequestSchema: { method: 'resources/list' },
  ReadResourceRequestSchema: { method: 'resources/read' },
  ListPromptsRequestSchema: { method: 'prompts/list' },
  GetPromptRequestSchema: { method: 'prompts/get' },
}));

// ── Helpers ────────────────────────────────────────────────────────────

function makeCallbacks(overrides: Partial<AgentServerCallbacks> = {}): AgentServerCallbacks {
  return {
    runTask: vi.fn().mockResolvedValue('session-123'),
    getSession: vi.fn().mockResolvedValue({
      id: 'session-123',
      task: 'do something',
      mode: 'execute',
      status: 'running',
      startedAt: Date.now(),
    } as AgentSession),
    getPlan: vi.fn().mockResolvedValue('# Plan\n\n## Step 1'),
    approvePlan: vi.fn().mockResolvedValue(true),
    cancelTask: vi.fn().mockResolvedValue(true),
    listSessions: vi.fn().mockResolvedValue([]),
    getTrace: vi.fn().mockResolvedValue('{"event":"start"}\n{"event":"end"}'),
    ...overrides,
  };
}

async function callTool(name: string, args: Record<string, unknown>) {
  const handler = mockHandlers.get('tools/call')!;
  return handler({ params: { name, arguments: args } });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('MCPAgentServer', () => {
  beforeEach(() => {
    mockHandlers.clear();
  });

  describe('run_task tool', () => {
    it('calls runTask callback and returns session_id', async () => {
      const callbacks = makeCallbacks();
      new MCPAgentServer(callbacks);

      const result = await callTool('run_task', { task: 'fix the bug' }) as {
        content: { type: string; text: string }[];
      };

      expect(callbacks.runTask).toHaveBeenCalledWith('fix the bug', 'execute', undefined);
      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.session_id).toBe('session-123');
      expect(parsed.status).toBe('started');
    });

    it('uses custom mode when provided', async () => {
      const callbacks = makeCallbacks();
      new MCPAgentServer(callbacks);

      await callTool('run_task', { task: 'make a plan', mode: 'plan' });

      expect(callbacks.runTask).toHaveBeenCalledWith('make a plan', 'plan', undefined);
    });

    it('rejects empty task', async () => {
      const callbacks = makeCallbacks();
      new MCPAgentServer(callbacks);

      const result = await callTool('run_task', { task: '' }) as {
        isError: boolean;
      };
      expect(result.isError).toBe(true);
    });
  });

  describe('get_session tool', () => {
    it('returns session data', async () => {
      const callbacks = makeCallbacks();
      new MCPAgentServer(callbacks);

      const result = await callTool('get_session', { session_id: 'session-123' }) as {
        content: { type: string; text: string }[];
      };

      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.id).toBe('session-123');
      expect(parsed.status).toBe('running');
    });

    it('returns error when session not found', async () => {
      const callbacks = makeCallbacks({
        getSession: vi.fn().mockResolvedValue(null),
      });
      new MCPAgentServer(callbacks);

      const result = await callTool('get_session', { session_id: 'unknown' }) as {
        isError: boolean;
      };
      expect(result.isError).toBe(true);
    });
  });

  describe('get_plan tool', () => {
    it('returns plan markdown', async () => {
      const callbacks = makeCallbacks();
      new MCPAgentServer(callbacks);

      const result = await callTool('get_plan', { session_id: 'session-123' }) as {
        content: { type: string; text: string }[];
      };

      expect(result.content[0]!.text).toContain('# Plan');
    });

    it('returns error when no plan available', async () => {
      const callbacks = makeCallbacks({
        getPlan: vi.fn().mockResolvedValue(null),
      });
      new MCPAgentServer(callbacks);

      const result = await callTool('get_plan', { session_id: 'session-123' }) as {
        isError: boolean;
      };
      expect(result.isError).toBe(true);
    });
  });

  describe('approve_plan tool', () => {
    it('calls approvePlan and returns approved: true', async () => {
      const callbacks = makeCallbacks();
      new MCPAgentServer(callbacks);

      const result = await callTool('approve_plan', { session_id: 'session-123' }) as {
        content: { type: string; text: string }[];
      };

      expect(callbacks.approvePlan).toHaveBeenCalledWith('session-123');
      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.approved).toBe(true);
    });
  });

  describe('cancel_task tool', () => {
    it('calls cancelTask and returns cancelled: true', async () => {
      const callbacks = makeCallbacks();
      new MCPAgentServer(callbacks);

      const result = await callTool('cancel_task', { session_id: 'session-123' }) as {
        content: { type: string; text: string }[];
      };

      expect(callbacks.cancelTask).toHaveBeenCalledWith('session-123');
      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.cancelled).toBe(true);
    });
  });

  describe('unknown tool', () => {
    it('returns isError for unknown tool names', async () => {
      const callbacks = makeCallbacks();
      new MCPAgentServer(callbacks);

      const result = await callTool('explode', {}) as { isError: boolean };
      expect(result.isError).toBe(true);
    });
  });

  describe('rate limiting', () => {
    it('blocks requests exceeding maxRequestsPerMinute', async () => {
      const callbacks = makeCallbacks();
      const _server = new MCPAgentServer(callbacks, { maxRequestsPerMinute: 3 });

      // 3 OK, 4th should error
      for (let i = 0; i < 3; i++) {
        const result = await callTool('get_session', { session_id: 'session-123' });
        expect((result as { isError?: boolean }).isError).not.toBe(true);
      }

      const blocked = await callTool('get_session', { session_id: 'session-123' }) as {
        isError: boolean;
        content: { text: string }[];
      };
      expect(blocked.isError).toBe(true);
      expect(blocked.content[0]!.text).toContain('Rate limit');
    });

    it('does not rate limit when maxRequestsPerMinute is 0', async () => {
      const callbacks = makeCallbacks();
      new MCPAgentServer(callbacks, { maxRequestsPerMinute: 0 });

      for (let i = 0; i < 10; i++) {
        const result = await callTool('get_session', { session_id: 'session-123' });
        expect((result as { isError?: boolean }).isError).not.toBe(true);
      }
    });
  });

  describe('list tools', () => {
    it('lists 5 tools', async () => {
      const callbacks = makeCallbacks();
      new MCPAgentServer(callbacks);

      const handler = mockHandlers.get('tools/list')!;
      const result = await handler({}) as { tools: { name: string }[] };

      expect(result.tools).toHaveLength(5);
      const names = result.tools.map((t) => t.name);
      expect(names).toContain('run_task');
      expect(names).toContain('get_session');
      expect(names).toContain('get_plan');
      expect(names).toContain('approve_plan');
      expect(names).toContain('cancel_task');
    });
  });

  describe('list prompts', () => {
    it('lists 2 prompts', async () => {
      const callbacks = makeCallbacks();
      new MCPAgentServer(callbacks);

      const handler = mockHandlers.get('prompts/list')!;
      const result = await handler({}) as { prompts: { name: string }[] };

      expect(result.prompts).toHaveLength(2);
      expect(result.prompts.map((p) => p.name)).toEqual(
        expect.arrayContaining(['execute-task', 'plan-task']),
      );
    });
  });

  describe('get prompt', () => {
    async function getPrompt(name: string, args: Record<string, string>) {
      const handler = mockHandlers.get('prompts/get')!;
      return handler({ params: { name, arguments: args } }) as Promise<{
        messages: { content: { text: string } }[];
      }>;
    }

    it('execute-task prompt mentions run_task', async () => {
      const callbacks = makeCallbacks();
      new MCPAgentServer(callbacks);

      const result = await getPrompt('execute-task', { task: 'fix the bug' });
      expect(result.messages[0]!.content.text).toContain('run_task');
      expect(result.messages[0]!.content.text).toContain('fix the bug');
    });

    it('plan-task prompt mentions approve_plan', async () => {
      const callbacks = makeCallbacks();
      new MCPAgentServer(callbacks);

      const result = await getPrompt('plan-task', { task: 'design the API' });
      expect(result.messages[0]!.content.text).toContain('approve_plan');
      expect(result.messages[0]!.content.text).toContain('design the API');
    });

    it('unknown prompt throws', async () => {
      const callbacks = makeCallbacks();
      new MCPAgentServer(callbacks);

      const handler = mockHandlers.get('prompts/get')!;
      await expect(
        handler({ params: { name: 'ghost-prompt', arguments: {} } }),
      ).rejects.toThrow('Unknown prompt');
    });
  });
});
