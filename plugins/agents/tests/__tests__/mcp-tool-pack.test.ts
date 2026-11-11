import { describe, it, expect, vi } from 'vitest';
import { MCPToolPack } from '../../src/mcp/client/mcp-tool-pack.js';

// ── MCP SDK mock ───────────────────────────────────────────────────────

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  const Client = vi.fn();
  Client.prototype.connect = vi.fn().mockResolvedValue(undefined);
  Client.prototype.close = vi.fn().mockResolvedValue(undefined);
  Client.prototype.listTools = vi.fn().mockResolvedValue({
    tools: [
      {
        name: 'list_repos',
        description: 'List GitHub repositories',
        inputSchema: { type: 'object', properties: { owner: { type: 'string' } } },
      },
      {
        name: 'get_file',
        description: 'Get file contents',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
      {
        name: 'dangerous_delete',
        description: 'Delete a repository',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  });
  Client.prototype.callTool = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'result data' }],
    isError: false,
  });
  return { Client };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {},
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {},
}));

// ── Tests ──────────────────────────────────────────────────────────────

describe('MCPToolPack', () => {
  describe('connect()', () => {
    it('connects via stdio and discovers tools', async () => {
      const pack = new MCPToolPack({
        name: 'github',
        transport: 'stdio',
        command: 'mcp-github',
      });

      await pack.connect();

      expect(pack.connected).toBe(true);
      expect(pack.tools).toHaveLength(3);
      expect(pack.tools.map((t) => t.definition.function.name)).toContain('list_repos');
    });

    it('is idempotent — second connect() is a no-op', async () => {
      const pack = new MCPToolPack({
        name: 'github',
        transport: 'stdio',
        command: 'mcp-github',
      });

      await pack.connect();
      await pack.connect(); // second call

      expect(pack.connected).toBe(true);
    });

    it('sets namespace as mcp.<name>', async () => {
      const pack = new MCPToolPack({ name: 'my-server', transport: 'stdio', command: 'server' });
      expect(pack.namespace).toBe('mcp.my-server');
      expect(pack.id).toBe('mcp:my-server');
    });

    it('throws if stdio transport has no command', async () => {
      const pack = new MCPToolPack({ name: 'x', transport: 'stdio' });
      await expect(pack.connect()).rejects.toThrow('command');
    });

    it('throws if sse transport has no url', async () => {
      const pack = new MCPToolPack({ name: 'x', transport: 'sse' });
      await expect(pack.connect()).rejects.toThrow('url');
    });
  });

  describe('allowlist', () => {
    it('filters tools by allowedTools list', async () => {
      const onDenied = vi.fn();
      const pack = new MCPToolPack(
        {
          name: 'github',
          transport: 'stdio',
          command: 'mcp-github',
          allowedTools: ['list_repos', 'get_file'],
        },
        { onDenied },
      );

      await pack.connect();

      expect(pack.tools).toHaveLength(2);
      expect(pack.tools.map((t) => t.definition.function.name)).not.toContain('dangerous_delete');
      expect(onDenied).toHaveBeenCalledWith('github', 'dangerous_delete', 'not in allowlist');
    });

    it('exposes all tools when allowedTools is empty', async () => {
      const pack = new MCPToolPack({
        name: 'github',
        transport: 'stdio',
        command: 'mcp-github',
        allowedTools: [],
      });

      await pack.connect();
      expect(pack.tools).toHaveLength(3);
    });
  });

  describe('execute()', () => {
    it('calls MCP server and returns output', async () => {
      const pack = new MCPToolPack({
        name: 'github',
        transport: 'stdio',
        command: 'mcp-github',
      });
      await pack.connect();

      const tool = pack.tools.find((t) => t.definition.function.name === 'list_repos')!;
      const result = await tool.execute({ owner: 'kb-labs' });

      expect(result.output).toBe('result data');
      expect(result.success).toBe(true);
    });

    it('returns error result when not connected', async () => {
      const pack = new MCPToolPack({
        name: 'github',
        transport: 'stdio',
        command: 'mcp-github',
      });
      // Don't connect

      // Manually add a tool for testing (simulate pre-connected pack)
      // Direct test: call without connecting
      const result = await (pack as unknown as { callTool: (n: string, i: Record<string, unknown>) => Promise<{ success: boolean; error?: string }> }).callTool('list_repos', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('not connected');
    });
  });

  describe('audit + redaction', () => {
    it('calls onAudit before execution', async () => {
      const onAudit = vi.fn();
      const pack = new MCPToolPack(
        {
          name: 'github',
          transport: 'stdio',
          command: 'mcp-github',
          allowedTools: ['list_repos'],
        },
        { onAudit },
      );
      await pack.connect();

      const tool = pack.tools[0];
      if (!tool) {
        throw new Error('Expected first tool to exist');
      }
      await tool.execute({ owner: 'acme', token: 'secret' });

      expect(onAudit).toHaveBeenCalledTimes(1);
      expect(onAudit).toHaveBeenCalledWith('github', 'list_repos', { owner: 'acme', token: 'secret' });
    });

    it('redacts specified input fields in audit log', async () => {
      const onAudit = vi.fn();
      const pack = new MCPToolPack(
        {
          name: 'github',
          transport: 'stdio',
          command: 'mcp-github',
          allowedTools: ['list_repos'],
          redactInputFields: ['token', 'password'],
        },
        { onAudit },
      );
      await pack.connect();

      const tool = pack.tools[0];
      if (!tool) {
        throw new Error('Expected first tool to exist');
      }
      await tool.execute({ owner: 'acme', token: 'gh_secret_123', password: 'hunter2' });

      expect(onAudit).toHaveBeenCalledWith('github', 'list_repos', {
        owner: 'acme',
        token: '[REDACTED]',
        password: '[REDACTED]',
      });
    });

    it('redacts output patterns', async () => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client.prototype.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: [{ type: 'text', text: 'token=ghp_abc123_secret password=hunter2' }],
        isError: false,
      });

      const pack = new MCPToolPack({
        name: 'github',
        transport: 'stdio',
        command: 'mcp-github',
        allowedTools: ['list_repos'],
        redactOutputPatterns: [/ghp_\w+/g, /password=\S+/g],
      });
      await pack.connect();

      const tool = pack.tools[0];
      if (!tool) {
        throw new Error('Expected first tool to exist');
      }
      const result = await tool.execute({});

      expect(result.output).toBe('token=[REDACTED] [REDACTED]');
    });
  });

  describe('dispose()', () => {
    it('disconnects and clears tools', async () => {
      const pack = new MCPToolPack({
        name: 'github',
        transport: 'stdio',
        command: 'mcp-github',
      });

      await pack.connect();
      expect(pack.connected).toBe(true);

      await pack.dispose();
      expect(pack.connected).toBe(false);
      expect(pack.tools).toHaveLength(0);
    });
  });

  describe('callbacks', () => {
    it('calls onConnected with tool count after connect', async () => {
      const onConnected = vi.fn();
      const pack = new MCPToolPack(
        { name: 'github', transport: 'stdio', command: 'mcp-github' },
        { onConnected },
      );

      await pack.connect();
      expect(onConnected).toHaveBeenCalledWith('github', 3);
    });
  });
});
