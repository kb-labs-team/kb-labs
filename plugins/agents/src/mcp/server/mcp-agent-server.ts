/**
 * MCPAgentServer — exposes the KB Labs Agent as an MCP server.
 *
 * Allows IDE integrations (Claude Desktop, Cursor, etc.) to interact
 * with the agent system via the Model Context Protocol.
 *
 * Exposed via MCP:
 *
 * Tools:
 *   - run_task        — start an agent task, returns task_id
 *   - get_session     — get session status / result
 *   - get_plan        — retrieve the current plan (plan mode)
 *   - approve_plan    — approve a pending plan
 *   - cancel_task     — cancel a running task
 *
 * Resources:
 *   - agent://sessions/<id>  — session JSON
 *   - agent://plans/<id>     — plan markdown
 *   - agent://traces/<id>    — trace NDJSON
 *
 * Prompts:
 *   - execute-task    — system prompt for execute mode
 *   - plan-task       — system prompt for plan mode
 *
 * Security:
 *   - Optional auth token (X-Auth-Token header or Bearer token)
 *   - Rate limiting (maxRequestsPerMinute)
 *   - Input validation via Zod
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

export interface AgentSession {
  id: string;
  task: string;
  mode: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  result?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

export interface AgentServerCallbacks {
  /**
   * Start a new agent task. Must return a session ID.
   * The server calls this when `run_task` is invoked.
   */
  runTask(task: string, mode: string, options?: Record<string, unknown>): Promise<string>;

  /**
   * Get status / result of a session.
   */
  getSession(sessionId: string): Promise<AgentSession | null>;

  /**
   * Get the current plan markdown for a session (plan mode only).
   */
  getPlan(sessionId: string): Promise<string | null>;

  /**
   * Approve a pending plan. Returns success boolean.
   */
  approvePlan(sessionId: string): Promise<boolean>;

  /**
   * Cancel a running task.
   */
  cancelTask(sessionId: string): Promise<boolean>;

  /**
   * List all sessions (for resources).
   */
  listSessions(): Promise<AgentSession[]>;

  /**
   * Get trace data for a session.
   */
  getTrace(sessionId: string): Promise<string | null>;
}

export interface MCPAgentServerConfig {
  /** Server name shown to clients */
  name?: string;
  /** Server version */
  version?: string;
  /** Optional auth token. If set, all requests must include it. */
  authToken?: string;
  /** Max requests per minute (simple in-memory rate limiter). 0 = unlimited. */
  maxRequestsPerMinute?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// Input Schemas
// ═══════════════════════════════════════════════════════════════════════

const RunTaskInput = z.object({
  task: z.string().min(1).max(10_000).describe('The task to execute'),
  mode: z
    .enum(['execute', 'plan', 'spec', 'debug'])
    .default('execute')
    .describe('Agent execution mode'),
  options: z
    .record(z.unknown())
    .optional()
    .describe('Additional mode-specific options'),
});

const SessionIdInput = z.object({
  session_id: z.string().min(1).describe('Session ID returned by run_task'),
});

// ═══════════════════════════════════════════════════════════════════════
// MCPAgentServer
// ═══════════════════════════════════════════════════════════════════════

export class MCPAgentServer {
  private readonly server: Server;
  private readonly callbacks: AgentServerCallbacks;
  private readonly config: Required<MCPAgentServerConfig>;

  // Simple rate limiter
  private readonly requestTimestamps: number[] = [];

  constructor(callbacks: AgentServerCallbacks, config: MCPAgentServerConfig = {}) {
    this.callbacks = callbacks;
    this.config = {
      name: config.name ?? 'kb-labs-agent',
      version: config.version ?? '1.0.0',
      authToken: config.authToken ?? '',
      maxRequestsPerMinute: config.maxRequestsPerMinute ?? 60,
    };

    this.server = new Server(
      { name: this.config.name, version: this.config.version },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      },
    );

    this.registerHandlers();
  }

  // ── Start ────────────────────────────────────────────────────────────

  /**
   * Start serving via stdio (for Claude Desktop / Cursor integration).
   */
  async serveStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    await this.server.close();
  }

  // ── Rate Limiting ────────────────────────────────────────────────────

  private checkRateLimit(): void {
    if (this.config.maxRequestsPerMinute === 0) {
      return;
    }

    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    // Clean old timestamps
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0]! < oneMinuteAgo) {
      this.requestTimestamps.shift();
    }

    if (this.requestTimestamps.length >= this.config.maxRequestsPerMinute) {
      throw new Error(
        `Rate limit exceeded: max ${this.config.maxRequestsPerMinute} requests per minute`,
      );
    }

    this.requestTimestamps.push(now);
  }

  // ── Handlers ─────────────────────────────────────────────────────────

  private registerHandlers(): void {
    this.registerToolHandlers();
    this.registerResourceHandlers();
    this.registerPromptHandlers();
  }

  private registerToolHandlers(): void {
    // List tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'run_task',
          description: 'Start a new agent task. Returns a session_id for tracking.',
          inputSchema: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'The task to execute' },
              mode: {
                type: 'string',
                enum: ['execute', 'plan', 'spec', 'debug'],
                default: 'execute',
                description: 'Agent execution mode',
              },
              options: {
                type: 'object',
                description: 'Additional mode-specific options',
              },
            },
            required: ['task'],
          },
        },
        {
          name: 'get_session',
          description: 'Get the status and result of an agent session.',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: { type: 'string', description: 'Session ID from run_task' },
            },
            required: ['session_id'],
          },
        },
        {
          name: 'get_plan',
          description: 'Get the current plan (markdown) for a plan-mode session.',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: { type: 'string', description: 'Session ID from run_task' },
            },
            required: ['session_id'],
          },
        },
        {
          name: 'approve_plan',
          description: 'Approve a pending plan so the agent can execute it.',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: { type: 'string', description: 'Session ID from run_task' },
            },
            required: ['session_id'],
          },
        },
        {
          name: 'cancel_task',
          description: 'Cancel a running agent task.',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: { type: 'string', description: 'Session ID from run_task' },
            },
            required: ['session_id'],
          },
        },
      ],
    }));

    // Call tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        this.checkRateLimit();
        switch (name) {
          case 'run_task': {
            const input = RunTaskInput.parse(args);
            const sessionId = await this.callbacks.runTask(
              input.task,
              input.mode,
              input.options,
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ session_id: sessionId, status: 'started' }),
                },
              ],
            };
          }

          case 'get_session': {
            const input = SessionIdInput.parse(args);
            const session = await this.callbacks.getSession(input.session_id);
            if (!session) {
              return {
                content: [{ type: 'text', text: JSON.stringify({ error: 'Session not found' }) }],
                isError: true,
              };
            }
            return {
              content: [{ type: 'text', text: JSON.stringify(session) }],
            };
          }

          case 'get_plan': {
            const input = SessionIdInput.parse(args);
            const plan = await this.callbacks.getPlan(input.session_id);
            if (plan === null) {
              return {
                content: [
                  { type: 'text', text: JSON.stringify({ error: 'No plan available for this session' }) },
                ],
                isError: true,
              };
            }
            return {
              content: [{ type: 'text', text: plan }],
            };
          }

          case 'approve_plan': {
            const input = SessionIdInput.parse(args);
            const ok = await this.callbacks.approvePlan(input.session_id);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ approved: ok, session_id: input.session_id }),
                },
              ],
            };
          }

          case 'cancel_task': {
            const input = SessionIdInput.parse(args);
            const ok = await this.callbacks.cancelTask(input.session_id);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ cancelled: ok, session_id: input.session_id }),
                },
              ],
            };
          }

          default:
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
              isError: true,
            };
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    });
  }

  private registerResourceHandlers(): void {
    // List resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const sessions = await this.callbacks.listSessions();
      return {
        resources: sessions.map((s) => ({
          uri: `agent://sessions/${s.id}`,
          name: `Session ${s.id} (${s.status})`,
          description: `Task: ${s.task.slice(0, 80)}`,
          mimeType: 'application/json',
        })),
      };
    });

    // Read resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      this.checkRateLimit();
      const uri = request.params.uri;

      // agent://sessions/<id>
      const sessionMatch = uri.match(/^agent:\/\/sessions\/(.+)$/);
      if (sessionMatch) {
        const sessionId = sessionMatch[1]!;
        const session = await this.callbacks.getSession(sessionId);
        if (!session) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(session, null, 2),
            },
          ],
        };
      }

      // agent://plans/<id>
      const planMatch = uri.match(/^agent:\/\/plans\/(.+)$/);
      if (planMatch) {
        const planSessionId = planMatch[1]!;
        const plan = await this.callbacks.getPlan(planSessionId);
        if (plan === null) {
          throw new Error(`No plan for session: ${planSessionId}`);
        }
        return {
          contents: [
            {
              uri,
              mimeType: 'text/markdown',
              text: plan,
            },
          ],
        };
      }

      // agent://traces/<id>
      const traceMatch = uri.match(/^agent:\/\/traces\/(.+)$/);
      if (traceMatch) {
        const traceSessionId = traceMatch[1]!;
        const trace = await this.callbacks.getTrace(traceSessionId);
        if (trace === null) {
          throw new Error(`No trace for session: ${traceSessionId}`);
        }
        return {
          contents: [
            {
              uri,
              mimeType: 'application/x-ndjson',
              text: trace,
            },
          ],
        };
      }

      throw new Error(`Unknown resource URI: ${uri}`);
    });
  }

  private registerPromptHandlers(): void {
    // List prompts
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [
        {
          name: 'execute-task',
          description: 'System prompt guidance for executing a task with the agent',
          arguments: [
            { name: 'task', description: 'The task to execute', required: true },
          ],
        },
        {
          name: 'plan-task',
          description: 'System prompt guidance for planning a task before execution',
          arguments: [
            { name: 'task', description: 'The task to plan', required: true },
          ],
        },
      ],
    }));

    // Get prompt
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const task = (args?.['task'] as string) ?? '';

      switch (name) {
        case 'execute-task':
          return {
            description: 'Execute a task with the KB Labs agent',
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `Use the run_task tool to execute the following task in "execute" mode, then use get_session to monitor progress until it completes.\n\nTask: ${task}`,
                },
              },
            ],
          };

        case 'plan-task':
          return {
            description: 'Plan a task before execution',
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `Use run_task with mode="plan" for the following task. After it generates a plan, use get_plan to retrieve it, review it, then use approve_plan to proceed with execution.\n\nTask: ${task}`,
                },
              },
            ],
          };

        default:
          throw new Error(`Unknown prompt: ${name}`);
      }
    });
  }
}
