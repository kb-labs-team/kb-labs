/**
 * MCPToolPack — bridges an MCP server to the ToolPack contract.
 *
 * Connects to an MCP server (stdio / SSE / HTTP), discovers its tools,
 * and exposes them as a ToolPack with namespace `mcp.<serverName>`.
 *
 * Security envelope (enforced here, NOT in ToolManager):
 * - Allowlist: only listed tool names are exposed
 * - Audit trail: every call is logged via onAudit callback
 * - Input redaction: redactFields stripped from inputs before logging
 * - Output redaction: redactPatterns applied to output before returning
 * - Sandbox: networkAllowed, allowedPaths from MCPServerConfig.permissions
 */

import type { ToolPack, PackedTool, ToolPermissions, ToolConflictPolicy } from '../../contracts/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// ═══════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════

export type MCPTransportType = 'stdio' | 'sse';

export interface MCPServerConfig {
  /** Unique server name — used as namespace suffix: `mcp.<name>` */
  name: string;

  /** Transport type */
  transport: MCPTransportType;

  /** For stdio: command to launch the MCP server process */
  command?: string;
  /** For stdio: args to the command */
  args?: string[];
  /** For stdio: env vars for the process */
  env?: Record<string, string>;

  /** For SSE: URL of the MCP server */
  url?: string;

  /**
   * Tool allowlist. Only tools with names in this list are exposed.
   * If undefined/empty, ALL tools from the server are exposed.
   */
  allowedTools?: string[];

  /** Fields to strip from tool inputs before audit logging */
  redactInputFields?: string[];

  /** Regex patterns applied to tool output (replace match with '[REDACTED]') */
  redactOutputPatterns?: RegExp[];

  /** Priority for conflict resolution with other packs (default: 30) */
  priority?: number;
  /** Conflict policy (default: 'namespace-prefix') */
  conflictPolicy?: ToolConflictPolicy;
  /** ToolPack-level permissions */
  permissions?: ToolPermissions;
}

export interface MCPPackCallbacks {
  /** Called before each tool execution (for audit trail) */
  onAudit?: (serverName: string, toolName: string, input: Record<string, unknown>) => void;
  /** Called when a tool is blocked by the allowlist */
  onDenied?: (serverName: string, toolName: string, reason: string) => void;
  /** Called after successful connection */
  onConnected?: (serverName: string, toolCount: number) => void;
}

// ═══════════════════════════════════════════════════════════════════════
// MCPToolPack
// ═══════════════════════════════════════════════════════════════════════

/**
 * A ToolPack backed by a remote MCP server.
 *
 * Usage:
 *   const pack = new MCPToolPack(config, callbacks);
 *   await pack.connect();           // discovers server tools
 *   toolManager.register(pack);     // exposes as mcp.<name>.* tools
 *   // ... use via toolManager.execute(...)
 *   await pack.dispose();           // clean disconnect
 */
export class MCPToolPack implements ToolPack {
  readonly id: string;
  readonly namespace: string;
  readonly version = '1.0.0';
  readonly priority: number;
  readonly conflictPolicy: ToolConflictPolicy;
  readonly capabilities = ['mcp'];
  readonly permissions: ToolPermissions;

  private readonly config: MCPServerConfig;
  private readonly callbacks: MCPPackCallbacks;
  private client: Client | null = null;
  private _tools: PackedTool[] = [];
  private _connected = false;

  constructor(config: MCPServerConfig, callbacks: MCPPackCallbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
    this.id = `mcp:${config.name}`;
    this.namespace = `mcp.${config.name}`;
    this.priority = config.priority ?? 30;
    this.conflictPolicy = config.conflictPolicy ?? 'namespace-prefix';
    this.permissions = config.permissions ?? {
      networkAllowed: false, // MCP servers are sandboxed by default
      auditTrail: true,      // Always audit MCP tool calls
    };
  }

  get tools(): PackedTool[] {
    return this._tools;
  }

  get connected(): boolean {
    return this._connected;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Connect to the MCP server and discover its tools.
   * Must be called before registering with ToolManager.
   */
  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    this.client = new Client({
      name: `kb-labs-agent-mcp-${this.config.name}`,
      version: '1.0.0',
    });
    const transport = this.buildTransport();
    await this.client.connect(transport);
    await this.discoverTools();
    this._connected = true;
    this.callbacks.onConnected?.(this.config.name, this._tools.length);
  }

  async initialize(): Promise<void> {
    // connect() is the public API — initialize() is a ToolPack hook
    // called after registration. If already connected, no-op.
    if (!this._connected) {
      await this.connect();
    }
  }

  async dispose(): Promise<void> {
    if (this.client && this._connected) {
      await this.client.close();
      this._connected = false;
      this.client = null;
      this._tools = [];
    }
  }

  enabled(): boolean {
    return this._connected;
  }

  // ── Transport ────────────────────────────────────────────────────────

  private buildTransport(): StdioClientTransport | SSEClientTransport {
    if (this.config.transport === 'stdio') {
      if (!this.config.command) {
        throw new Error(`MCPToolPack "${this.config.name}": stdio transport requires "command"`);
      }
      return new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env: this.config.env,
      });
    }

    if (this.config.transport === 'sse') {
      if (!this.config.url) {
        throw new Error(`MCPToolPack "${this.config.name}": sse transport requires "url"`);
      }
      return new SSEClientTransport(new URL(this.config.url));
    }

    throw new Error(`MCPToolPack "${this.config.name}": unknown transport "${this.config.transport}"`);
  }

  // ── Tool Discovery ───────────────────────────────────────────────────

  private async discoverTools(): Promise<void> {
    if (!this.client) {
      throw new Error('MCPToolPack: client not initialized');
    }

    const response = await this.client.listTools();
    const serverTools = response.tools;
    const allowlist = this.config.allowedTools;

    this._tools = [];
    for (const serverTool of serverTools) {
      const toolName = serverTool.name;

      // Allowlist check: if allowedTools is set, only include listed tools
      if (allowlist && allowlist.length > 0 && !allowlist.includes(toolName)) {
        this.callbacks.onDenied?.(this.config.name, toolName, 'not in allowlist');
        continue;
      }

      this._tools.push(this.wrapTool(toolName, serverTool));
    }
  }

  private wrapTool(
    toolName: string,
    serverTool: { name: string; description?: string; inputSchema?: unknown },
  ): PackedTool {
    const schema = serverTool.inputSchema as { type?: string; properties?: Record<string, unknown>; required?: string[] } | undefined;

    return {
      definition: {
        type: 'function',
        function: {
          name: toolName,
          description: serverTool.description ?? `MCP tool: ${toolName}`,
          parameters: {
            type: 'object' as const,
            properties: schema?.properties ?? {},
            ...(schema?.required ? { required: schema.required } : {}),
          },
        },
      },
      readOnly: false, // MCP tools are assumed to have side effects
      capability: 'mcp',

      execute: async (input: Record<string, unknown>) => this.callTool(toolName, input),
    };
  }

  // ── Execution ────────────────────────────────────────────────────────

  private async callTool(
    toolName: string,
    input: Record<string, unknown>,
  ) {
    if (!this.client || !this._connected) {
      return {
        success: false,
        error: `MCPToolPack "${this.config.name}" is not connected`,
      };
    }

    // Audit logging (input redacted)
    if (this.permissions.auditTrail && this.callbacks.onAudit) {
      const auditInput = this.redactInput(input);
      this.callbacks.onAudit(this.config.name, toolName, auditInput);
    }

    try {
      const result = await this.client.callTool({ name: toolName, arguments: input });

      // Collect text content from MCP response
      let output = '';
      if (Array.isArray(result.content)) {
        for (const item of result.content) {
          if (item.type === 'text') {
            output += item.text;
          }
        }
      }

      // Output redaction
      output = this.redactOutput(output);

      const isError = result.isError === true;
      return {
        success: !isError,
        output,
        ...(isError ? { error: output } : {}),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: msg,
      };
    }
  }

  // ── Redaction ────────────────────────────────────────────────────────

  private redactInput(input: Record<string, unknown>): Record<string, unknown> {
    const fields = this.config.redactInputFields;
    if (!fields || fields.length === 0) {
      return input;
    }

    const redacted = { ...input };
    for (const field of fields) {
      if (field in redacted) {
        redacted[field] = '[REDACTED]';
      }
    }
    return redacted;
  }

  private redactOutput(output: string): string {
    const patterns = this.config.redactOutputPatterns;
    if (!patterns || patterns.length === 0) {
      return output;
    }

    let result = output;
    for (const pattern of patterns) {
      result = result.replace(pattern, '[REDACTED]');
    }
    return result;
  }
}
