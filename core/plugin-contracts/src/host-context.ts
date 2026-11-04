/**
 * Host-specific context for V3 Plugin System
 *
 * Each entry point (CLI, REST, Workflow, Webhook) provides different context.
 * This is a discriminated union based on the 'host' field.
 */

/**
 * CLI host context
 */
export interface CliHostContext {
  readonly host: 'cli';
  /** Registered executable name from the CLI manifest. */
  readonly binaryName: string;
  /** Raw command line arguments */
  readonly argv: string[];
  /** Parsed flags */
  readonly flags: Record<string, unknown>;
  /** Resolve the platform version only for commands that report it. */
  readonly resolvePlatformVersion?: () => Promise<string>;
}

/**
 * REST API host context
 */
export interface RestHostContext {
  readonly host: 'rest';
  /** HTTP method */
  readonly method: string;
  /** Request path */
  readonly path: string;
  /** Request headers */
  readonly headers?: Record<string, string>;
  /** Query parameters */
  readonly query?: Record<string, string>;
  /** Request body */
  readonly body?: unknown;
  /** Request ID for correlation */
  readonly requestId: string;
  /** Trace ID for distributed tracing */
  readonly traceId: string;
  /** Tenant ID for multi-tenancy (optional) */
  readonly tenantId?: string;
}

/**
 * Workflow host context
 */
export interface WorkflowHostContext {
  readonly host: 'workflow';
  /** Workflow definition ID */
  readonly workflowId: string;
  /** Workflow run ID */
  readonly runId: string;
  /** Job ID within the workflow run (optional - for multi-job workflows) */
  readonly jobId?: string;
  /** Current step ID */
  readonly stepId: string;
  /** Step execution attempt number (1-indexed, for retry tracking) */
  readonly attempt?: number;
  /** Step input data */
  readonly input?: unknown;
}

/**
 * Webhook host context
 */
export interface WebhookHostContext {
  readonly host: 'webhook';
  /** Event name (matches WebhookHandlerDecl.event) */
  readonly event: string;
  /** Caller IP address */
  readonly source?: string;
  /** Webhook request payload (parsed JSON body) */
  readonly payload?: unknown;
  /** Tenant namespace ID (from x-kb-namespace header) */
  readonly namespaceId: string;
  /** Unique delivery ID (UUID v4, generated per request) */
  readonly webhookId: string;
  /** Instance ID — present when the hook is declared with multi: true */
  readonly instanceId?: string;
}

/**
 * Cron host context - for scheduled plugin execution
 *
 * Unlike Workflow (user orchestration), Cron is plugin-owned scheduling.
 * The plugin defines WHEN and HOW OFTEN it runs via manifest.
 */
export interface CronHostContext {
  readonly host: 'cron';
  /** Cron job ID from manifest */
  readonly cronId: string;
  /** Cron schedule expression (e.g., "0 * * * *") */
  readonly schedule: string;
  /** When this run was scheduled (ISO string) */
  readonly scheduledAt: string;
  /** Previous run timestamp (ISO string, optional) */
  readonly lastRunAt?: string;
}

/**
 * WebSocket host context - for real-time bidirectional communication
 */
export interface WebSocketHostContext {
  readonly host: 'ws';
  /** Channel path (e.g., "/live", "/chat") */
  readonly channelPath: string;
  /** Connection ID (unique per connection) */
  readonly connectionId: string;
  /** Client IP address */
  readonly clientIp: string;
  /** Initial HTTP upgrade headers */
  readonly headers: Record<string, string>;
  /** Query parameters from upgrade request */
  readonly query?: Record<string, string>;
  /** Path parameters extracted from URL pattern (e.g., { runId: "abc" } for /events/:runId) */
  readonly params?: Record<string, string>;
  /** Request ID for correlation */
  readonly requestId: string;
  /** Trace ID for distributed tracing */
  readonly traceId: string;
  /** Tenant ID for multi-tenancy (optional) */
  readonly tenantId?: string;
  /** Authenticated user info (if auth enabled) */
  readonly user?: {
    id: string;
    name?: string;
    roles?: string[];
  };
}

/**
 * Discriminated union of all host contexts
 */
export type HostContext =
  | CliHostContext
  | RestHostContext
  | WorkflowHostContext
  | WebhookHostContext
  | CronHostContext
  | WebSocketHostContext;

/**
 * Host type literal
 */
export type HostType = HostContext['host'];
