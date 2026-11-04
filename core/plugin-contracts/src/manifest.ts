/**
 * Plugin Manifest V3
 *
 * Declarative metadata for V3 plugin system.
 * Combines the best of V2 (declarative) with V3 architecture (sandboxed, type-safe).
 */

import type { PermissionSpec } from "./permissions.js";
import type { HostType } from "./host-context.js";
import type { PluginServices } from "./platform.js";
import type { CliFlagDecl } from './cli-schema.js';

// ─── Studio V2 (Module Federation Pages) ───────────────────────────

/**
 * Studio configuration for plugin UI pages.
 * Each page is a Module Federation remote React component.
 * Plugin owns the entire page — full React, UIKit, hooks.
 */
export interface StudioConfig {
  /** Schema version (always 2) */
  version: 2;
  /** Module Federation remote name (e.g. 'commitPlugin') */
  remoteName: string;
  /** Page declarations */
  pages: StudioPageEntry[];
  /** Navigation menu entries */
  menus?: StudioMenuEntry[];
}

/**
 * A plugin page — one MF exposed React component.
 * Plugin is full owner inside the page.
 */
export interface StudioPageEntry {
  /** Unique page ID, dot-namespaced: 'commit.overview' */
  id: string;
  /** Human-readable title */
  title: string;
  /** Icon name (AntD icon names) */
  icon?: string;
  /** Route path: '/commit' */
  route: string;
  /** MF exposed module path: './CommitOverview' */
  entry: string;
  /** Required permissions to access this page */
  permissions?: string[];
  /** Render order in navigation */
  order?: number;
}

/**
 * Navigation menu entry for the Studio sidebar.
 */
export interface StudioMenuEntry {
  /** Unique menu item ID */
  id: string;
  /** Display label */
  label: string;
  /** Icon name (AntD icon names) */
  icon?: string;
  /** Target page ID or external URL */
  target: string;
  /** Render order */
  order?: number;
  /** Parent menu ID for nesting */
  parentId?: string;
  /** Required permissions */
  permissions?: string[];
  /** Badge text */
  badge?: string;
}

/**
 * Schema reference for input/output validation
 */
export type SchemaRef =
  | { $ref: string } // OpenAPI JSON Schema reference
  | { zod: string }; // Zod schema reference: './path/to/schema.ts#exportedSchema'

/**
 * Display metadata for plugin
 */
export interface DisplayMetadata {
  /** Plugin name (human-readable) */
  name: string;
  /** Plugin description */
  description?: string;
  /** Plugin author */
  author?: string;
  /** Plugin homepage URL */
  homepage?: string;
  /** Plugin repository URL */
  repository?: string;
  /** Tags for categorization */
  tags?: string[];
  /** Plugin icon (URL or emoji) */
  icon?: string;
}

/**
 * Plugin dependency declaration
 */
export interface PluginDependency {
  /** Plugin ID (@scope/name) */
  id: string;
  /** Semver range (e.g., '^1.0.0', '>=2.0.0') */
  version: string;
  /** Optional dependency (plugin still loads if missing) */
  optional?: boolean;
}

/**
 * Platform service requirements
 */
// Derived from PluginServices (itself re-exported from @kb-labs/core-platform's
// IPluginAdapters — the same interface ADAPTER_REGISTRY's `satisfies` clause
// enforces against in core/plugin-runtime) instead of a separately maintained
// literal union. Previously this list drifted from the registry's real key
// set (missing eventBus, config, invoke, documentDatabase, kvStore, logs,
// artifacts, snapshotManager) and `optional` wasn't constrained at all — see
// ADR-0026.
type PlatformCapability = keyof Required<PluginServices>;

export interface PlatformRequirements {
  /** Required services (plugin fails to load if missing) */
  requires?: Array<PlatformCapability>;
  /** Optional services (features degraded if missing) */
  optional?: Array<PlatformCapability>;
}

/**
 * CLI command flag definition
 */
/**
 * CLI command declaration.
 *
 * `path` is the full command path as space-separated tokens, e.g.:
 *   'hello'                → kb hello
 *   'marketplace install'  → kb marketplace install
 *   'clickup task search'  → kb clickup task search
 */
export interface CliCommandDecl {
  /** Full command path (space-separated tokens, from root). */
  path: string;
  /** Short description */
  describe: string;
  /** Long description (for --help) */
  longDescription?: string;
  /** Command flags */
  flags?: CliFlagDecl[];
  /** Usage examples */
  examples?: string[];
  /** Handler file path relative to plugin root (e.g., './dist/commands/hello.js') */
  handler: string;
  /** Command-specific permissions (overrides plugin defaults) */
  permissions?: PermissionSpec;
  /** Require an authenticated platform session before this command is dispatched. */
  /** Display-only category label (does not affect routing) */
  category?: string;
  /** Alternative full paths for this command (e.g., ['cu task search']) */
  aliases?: string[];
  /**
   * Opt-in command archetype. Declaring it enables automatic flag injection
   * (standard flags for the archetype) and `--schema` output generation.
   *   read    → --output, --limit, --offset
   *   mutate  → --output, --dry-run, --yes
   *   execute → --output, --wait, --watch, --timeout, --yes
   *   analyze → --output, --format, --stream
   */
  operationType?: "read" | "mutate" | "execute" | "analyze";
}

/**
 * Metadata for CLI groups/subgroups — used for help display.
 */
export interface CliGroupMeta {
  /** Full group path as space-separated tokens (e.g., 'marketplace' or 'marketplace plugins') */
  path: string;
  /** Human-readable description */
  describe: string;
}

/**
 * Split a CliCommandDecl path into routing segments.
 * Example: 'clickup task search' → ['clickup', 'task', 'search']
 */
export function getCommandSegments(decl: CliCommandDecl): string[] {
  return decl.path.trim().split(/\s+/);
}

/**
 * REST route error specification
 */
export interface ErrorSpec {
  /** Error code (e.g., 'CONFIG_NOT_RESOLVED') */
  code: string;
  /** HTTP status code (400-599) */
  http: number;
  /** Human-readable description */
  description?: string;
}

/**
 * REST route declaration
 */
export interface RestRouteDecl {
  /** HTTP method */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Route path (relative to basePath, e.g., '/search') */
  path: string;
  /** Human-readable description for OpenAPI docs */
  description?: string;
  /** Route-specific timeout in milliseconds */
  timeoutMs?: number;
  /** Input schema (body for POST/PUT/PATCH, query for GET) */
  input?: SchemaRef;
  /** Output schema */
  output?: SchemaRef;
  /** Declared error responses */
  errors?: ErrorSpec[];
  /** Handler file path relative to plugin root (e.g., './dist/rest/search.js') */
  handler: string;
  /** Security requirements */
  security?: ("none" | "user" | "token" | "oauth")[];
  /** Route-specific permissions (overrides plugin defaults) */
  permissions?: PermissionSpec;
}

/** Declarative server-sent event stream implemented by a plugin. */
export interface SseStreamDecl {
  path: string;
  description?: string;
  /** Handler file path relative to the plugin root. */
  handler: string;
  timeoutMs?: number;
  keepAliveMs?: number;
  /** Security requirements, matching ordinary REST route declarations. */
  security?: ("none" | "user" | "token" | "oauth")[];
  permissions?: PermissionSpec;
}

/**
 * REST API configuration
 */
export interface RestConfig {
  /** Base path for all routes (e.g., '/v1/plugins/mind') */
  basePath?: `/v1/plugins/${string}`;
  /** Default route behaviour */
  defaults?: {
    /** Default timeout for routes (milliseconds) */
    timeoutMs?: number;
  };
  /** Route declarations */
  routes: RestRouteDecl[];
}

/**
 * Server-sent event transport configuration.
 *
 * SSE is delivered over HTTP, but it is a long-lived realtime transport with
 * lifecycle handlers. It therefore follows the same manifest shape as `ws`.
 */
export interface SseConfig {
  /** Base path for all streams (e.g. '/v1/plugins/mind'). */
  basePath?: `/v1/plugins/${string}`;
  /** Defaults inherited by every stream. */
  defaults?: {
    timeoutMs?: number;
    keepAliveMs?: number;
  };
  /** Stream declarations. */
  streams: SseStreamDecl[];
}

/**
 * WebSocket channel declaration
 */
export interface WebSocketChannelDecl {
  /** Channel path (e.g., '/live', '/chat') */
  path: string;

  /** Human-readable description */
  description?: string;

  /** Channel-specific protocol/subprotocol */
  protocol?: string;

  /** Handler file path relative to plugin root (e.g., './dist/ws/live-handler.js') */
  handler: string;

  /** Input message schema (client → server) */
  inputMessage?: SchemaRef;

  /** Output message schema (server → client) */
  outputMessage?: SchemaRef;

  /** Channel-specific permissions (overrides plugin defaults) */
  permissions?: PermissionSpec;

  /** Connection timeout in milliseconds */
  timeoutMs?: number;

  /** Max message size in bytes */
  maxMessageSize?: number;

  /** Authentication requirement */
  auth?: "none" | "token" | "session";

  /** Idle timeout (auto-disconnect after this many ms of inactivity) */
  idleTimeoutMs?: number;
}

/**
 * WebSocket configuration in manifest
 */
export interface WebSocketConfig {
  /** Base path for all channels (e.g., '/v1/ws/plugins/commit') */
  basePath?: `/v1/ws/plugins/${string}`;

  /** Default settings for all channels */
  defaults?: {
    /** Default connection timeout (milliseconds) */
    timeoutMs?: number;
    /** Default max message size (bytes) */
    maxMessageSize?: number;
    /** Default auth requirement */
    auth?: "none" | "token" | "session";
    /** Default idle timeout (milliseconds) */
    idleTimeoutMs?: number;
  };

  /** Channel declarations */
  channels: WebSocketChannelDecl[];
}

/**
 * Workflow handler declaration
 */
export interface WorkflowHandlerDecl {
  /** Unique workflow identifier (e.g., 'sync-dependencies') */
  id: string;
  /** Human-readable description */
  describe?: string;
  /** Handler file path relative to plugin root (e.g., './dist/workflows/sync.js') */
  handler: string;
  /** Input schema */
  input?: SchemaRef;
  /** Output schema */
  output?: SchemaRef;
  /** Handler-specific permissions */
  permissions?: PermissionSpec;
}

/**
 * Workflow template declaration — static YAML workflow bundled with plugin.
 * Registered in the workflow engine registry and runnable via `kb workflow run`.
 */
export interface WorkflowTemplateDecl {
  /** Unique template ID within the plugin (e.g. 'full-release') */
  id: string;
  /** Human-readable description */
  describe?: string;
  /** Path to YAML workflow file relative to plugin root (e.g. './workflows/templates/full-release.yaml') */
  path: string;
  /** Optional tags for filtering */
  tags?: string[];
}

// ── Webhook Auth Config ────────────────────────────────────────────────────────

/**
 * Static secret validation: compare request header value against stored secret.
 * Uses constant-time comparison to prevent timing attacks.
 */
export interface WebhookAuthSecret {
  type: "secret";
  /** Header name carrying the secret (e.g. 'X-Webhook-Secret') */
  header: string;
}

/**
 * HMAC-SHA256 payload signature validation.
 * Gateway computes HMAC over the raw request body and compares to the header.
 */
export interface WebhookAuthHmac {
  type: "hmac";
  /** Header name carrying the signature (e.g. 'X-Hub-Signature-256') */
  header: string;
  /** Optional prefix to strip before comparing (e.g. 'sha256=') */
  prefix?: string;
}

/**
 * Custom validation delegated to a plugin handler via backend.execute.
 * Handler receives { headers, rawBody (base64), secret } and returns { valid: boolean }.
 * Plugin code never runs in-process — always isolated through backend.execute.
 */
export interface WebhookAuthCustom {
  type: "custom";
  /** Handler path: './dist/webhooks/stripe-validate.js#default' */
  validator: string;
}

/** Discriminated union of all supported webhook auth strategies. */
export type WebhookAuthConfig =
  | WebhookAuthSecret
  | WebhookAuthHmac
  | WebhookAuthCustom;

/**
 * Challenge/handshake protocol config (e.g. Slack URL verification).
 * When an incoming request matches `bodyPath === value`, the gateway responds
 * automatically with `{ [replyPath]: body[replyPath] }` — plugin handler is NOT called.
 */
export interface WebhookChallengeConfig {
  /** Dot-path to the discriminator field in the request body (e.g. 'type') */
  bodyPath: string;
  /** Expected value that identifies a challenge request (e.g. 'url_verification') */
  value: string;
  /** Dot-path to the field to echo back in the response (e.g. 'challenge') */
  replyPath: string;
}

/**
 * Webhook handler declaration
 */
export interface WebhookHandlerDecl {
  /** Event name / hook identifier (e.g. 'alert', 'push', 'update') */
  event: string;
  /** Human-readable description */
  describe?: string;
  /** Handler file path relative to plugin root (e.g., './dist/webhooks/github.js#default') */
  handler: string;
  /**
   * Auth configuration — REQUIRED.
   * Omitting auth causes the gateway to refuse startup with a descriptive error.
   */
  auth: WebhookAuthConfig;
  /** Input schema (webhook payload) */
  input?: SchemaRef;
  /** Handler-specific permissions */
  permissions?: PermissionSpec;
  /**
   * Multi-instance mode.
   * When true, the route becomes /webhooks/{pluginId}/{event}/:instanceId.
   * Each instanceId has its own independently provisioned secret.
   */
  multi?: boolean;
  /**
   * Async dispatch mode.
   * When true, the gateway responds 202 immediately and dispatches the handler
   * in the background via backend.execute (fire-and-forget, errors logged).
   */
  async?: boolean;
  /**
   * Challenge/handshake protocol (e.g. Slack URL verification).
   * The gateway handles matching requests automatically without invoking the handler.
   */
  challenge?: WebhookChallengeConfig;
  /**
   * Dot-path into the request body for idempotency deduplication.
   * Duplicate deliveries within 7 days return 200 without calling the handler.
   */
  idempotencyKey?: string;
  /**
   * Handler path called by the platform after kb webhook provision generates a secret.
   * Called via backend.execute with { instanceId, secret, url }.
   */
  onProvision?: string;
  /**
   * Maximum request body size in bytes for this hook.
   * Defaults to 512 * 1024 (512 KB) if not specified.
   */
  maxBodyBytes?: number;
  /**
   * Per-hook rate limit enforced via IResourceBroker.tryAcquire.
   * Defaults to 60 requests per minute if not specified.
   */
  rateLimit?: { requestsPerMinute: number };
}

/**
 * Job handler declaration for background task execution
 *
 * Job handlers are executed in sandboxed subprocess when submitted via ctx.api.jobs.submit()
 * These are different from scheduled jobs (JobDecl) - handlers are invoked on-demand.
 *
 * @example
 * ```json
 * {
 *   "jobs": {
 *     "handlers": [
 *       {
 *         "id": "send-email",
 *         "handler": "./dist/jobs/send-email.js",
 *         "describe": "Send email via SendGrid",
 *         "timeout": 30000,
 *         "maxRetries": 3
 *       }
 *     ]
 *   }
 * }
 * ```
 */
export interface JobHandlerDecl {
  /** Unique job identifier (e.g., 'send-email', 'process-file') */
  id: string;

  /** Human-readable description */
  describe?: string;

  /** Handler file path relative to plugin root (e.g., './dist/jobs/send-email.js') */
  handler: string;

  /** Input schema for validation */
  input?: SchemaRef;

  /** Output schema */
  output?: SchemaRef;

  /** Job-specific timeout in milliseconds (overrides defaults) */
  timeout?: number;

  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;

  /** Retry backoff strategy */
  retryBackoff?: "exp" | "lin";

  /** Handler-specific permissions (can access what?) */
  permissions?: PermissionSpec;
}

/**
 * Jobs configuration in manifest
 */
export interface JobsConfig {
  /** Job handler declarations */
  handlers: JobHandlerDecl[];

  /** Default settings for all jobs */
  defaults?: {
    /** Default timeout in milliseconds */
    timeout?: number;
    /** Default max retries */
    maxRetries?: number;
    /** Default backoff strategy */
    retryBackoff?: "exp" | "lin";
  };
}

/**
 * Cron schedule declaration for recurring tasks
 *
 * @example
 * ```json
 * {
 *   "cron": {
 *     "schedules": [
 *       {
 *         "id": "daily-cleanup",
 *         "schedule": "0 3 * * *",
 *         "job": {
 *           "type": "cleanup-logs",
 *           "payload": { "olderThanDays": 7 }
 *         }
 *       }
 *     ]
 *   }
 * }
 * ```
 */
export interface CronDecl {
  /** Unique cron schedule identifier (e.g., 'daily-cleanup') */
  id: string;

  /** Cron expression ('0 * * * *') or interval ('5m', '1h', '1d') */
  schedule: string;

  /** Job to execute on schedule */
  job: {
    /** Job type (pluginId:jobId or just jobId for same plugin) */
    type: string;
    /** Job payload */
    payload?: unknown;
  };

  /** Human-readable description */
  describe?: string;

  /** Whether schedule is enabled by default */
  enabled?: boolean;

  /** Timezone for cron expression (default: UTC) */
  timezone?: string;

  /** Cron-specific permissions */
  permissions?: PermissionSpec;
}

/**
 * @deprecated Use CronDecl instead (renamed for clarity)
 */
export type JobDecl = CronDecl;

/**
 * Lifecycle hook specification
 */
export interface LifecycleHooks {
  /** Handler executed when plugin loads (initialization) */
  onLoad?: string;
  /** Handler executed when plugin unloads (cleanup) */
  onUnload?: string;
  /** Handler executed when plugin is enabled */
  onEnable?: string;
  /** Handler executed when plugin is disabled */
  onDisable?: string;
}

/**
 * Setup command specification
 */
export interface SetupSpec {
  /** Handler file path for setup (e.g., './dist/setup.js') */
  handler: string;
  /** Human-readable description */
  describe: string;
  /** Setup-specific permissions (usually broader than runtime) */
  permissions: PermissionSpec;
}

/**
 * Plugin Manifest V3
 *
 * Declarative metadata for plugin capabilities, handlers, and requirements.
 *
 * @example kb.plugin.json
 * ```json
 * {
 *   "schema": "kb.plugin/3",
 *   "id": "@kb-labs/my-plugin",
 *   "version": "1.0.0",
 *   "display": {
 *     "name": "My Plugin",
 *     "description": "Does cool things"
 *   },
 *   "permissions": {
 *     "fs": { "mode": "read", "allow": [".kb/**"] },
 *     "net": { "allowHosts": ["api.example.com"] }
 *   },
 *   "cli": {
 *     "commands": [{
 *       "path": "hello",
 *       "describe": "Say hello",
 *       "handler": "./dist/commands/hello.js",
 *       "flags": []
 *     }]
 *   }
 * }
 * ```
 */
export interface ManifestV3 {
  /** Schema version */
  schema: "kb.plugin/3";

  /** Plugin identifier (@scope/name) */
  id: string;

  /** Plugin version (semver) */
  version: string;

  /** Release compatibility constraints copied into the sealed platform index. */
  compatibility?: {
    platformRange?: string;
    sdkRange?: string;
  };

  /**
   * Config section identifier in kb.config.json
   * Used by runtime to load plugin-specific config
   * @example 'mind' maps to kb.config.json → profiles[].products.mind
   */
  configSection?: string;

  /**
   * Optional schema and defaults for values stored under `plugins.<configSection>`.
   * `schema` may be an inline JSON Schema or a SchemaRef resolved by the host.
   */
  settings?: {
    schema: Record<string, unknown> | SchemaRef;
    defaults?: Record<string, unknown>;
  };

  /** Display metadata */
  display?: DisplayMetadata;

  /** Plugin-wide permission defaults */
  permissions?: PermissionSpec;

  /** Plugin dependencies */
  dependencies?: PluginDependency[];

  /** Platform service requirements */
  platform?: PlatformRequirements;

  /** Setup command (runs during installation/initialization) */
  setup?: SetupSpec;

  /** Lifecycle hooks (onLoad, onUnload, onEnable, onDisable) */
  lifecycle?: LifecycleHooks;

  /** CLI commands */
  cli?: {
    commands: CliCommandDecl[];
    /** Descriptions for groups/subgroups (for help display) */
    groupMeta?: CliGroupMeta[];
  };

  /** REST API routes */
  rest?: RestConfig;

  /** WebSocket channels (real-time bidirectional communication) */
  ws?: WebSocketConfig;

  /** Server-sent event streams (real-time server-to-client communication). */
  sse?: SseConfig;

  /** Workflow handlers (multi-step orchestration) */
  workflows?: {
    handlers: WorkflowHandlerDecl[];
    /** Static YAML workflow templates bundled with the plugin */
    templates?: WorkflowTemplateDecl[];
  };

  /** Webhook handlers */
  webhooks?: {
    handlers: WebhookHandlerDecl[];
  };

  /** Background job handlers (single-step tasks, invoked on-demand via ctx.api.jobs.submit) */
  jobs?: JobsConfig;

  /** Cron scheduled tasks (recurring jobs on schedule) */
  cron?: {
    /** Cron schedule declarations */
    schedules: CronDecl[];
  };

  /** Studio pages (Module Federation remotes) */
  studio?: StudioConfig;

  /**
   * Resources this plugin exports for other plugins to depend on.
   *
   * Currently scoped to document-database collections — cross-plugin reads
   * (e.g. `billing` reading `users` from `auth`) require the OWNER to opt
   * in via this field AND the consumer to declare a matching grant in
   * `permissions.platform.database.document.access`. The install-time
   * validator rejects any consumer grant without a corresponding export.
   *
   * Treat exports as a public surface: removing a collection here is a
   * breaking change for any plugin that grants on it.
   */
  exports?: {
    /**
     * Document collections this plugin owns and offers to consumers.
     *
     * @example
     * exports: {
     *   collections: [
     *     { name: 'users', ops: ['read'] },      // read-only API for other plugins
     *     { name: 'sessions' },                   // default ['read']
     *   ]
     * }
     */
    collections?: Array<{
      /** Collection name (no namespace prefix). Must match an entry in `permissions.platform.database.document.owns`. */
      name: string;
      /** Operations exposed to other plugins. Default: `['read']`. */
      ops?: Array<"read" | "write">;
    }>;
  };
}

export type PluginRouteSurface = "rest" | "sse" | "ws";

/** The manifest fields needed to resolve a plugin transport's shared base-path convention. */
export type PluginBasePathManifest = Pick<ManifestV3, "id"> & {
  rest?: { basePath?: string };
  sse?: { basePath?: string };
  ws?: { basePath?: string };
};

/** Resolve the effective mount prefix for one declared plugin transport. */
export function resolvePluginBasePath(
  manifest: PluginBasePathManifest,
  surface: PluginRouteSurface,
  configBasePath: string,
): string {
  const configBase = configBasePath.replace(/\/$/, "");
  const declaredBasePath = manifest[surface]?.basePath;

  if (surface === "sse" && !declaredBasePath) {
    return resolvePluginBasePath(manifest, "rest", configBase);
  }

  const basePath = declaredBasePath || (surface === "ws"
    ? `/v1/ws/plugins/${manifest.id}`
    : `/plugins/${manifest.id}`);
  if (basePath.startsWith("/api/")) return basePath;
  if (basePath.startsWith("/v1/")) return basePath.replace(/^\/v1/, configBase);
  return `${configBase}${basePath.startsWith("/") ? "" : "/"}${basePath}`;
}

/**
 * Type guard to check if manifest is V3
 */
export function isManifestV3(manifest: unknown): manifest is ManifestV3 {
  return (
    typeof manifest === "object" &&
    manifest !== null &&
    "schema" in manifest &&
    manifest.schema === "kb.plugin/3"
  );
}

/**
 * Get handler path for specific command/route/workflow
 */
export function getHandlerPath(
  manifest: ManifestV3,
  host: HostType,
  id: string,
): string | undefined {
  switch (host) {
    case "cli":
      return manifest.cli?.commands.find((cmd) => cmd.path === id)?.handler;
    case "rest":
      return (
        manifest.rest?.routes.find(
          (route) => `${route.method} ${route.path}` === id,
        )?.handler ??
        manifest.sse?.streams.find((stream) => stream.path === id)?.handler
      );
    case "ws":
      return manifest.ws?.channels.find((ch) => ch.path === id)?.handler;
    case "workflow":
      return manifest.workflows?.handlers.find((h) => h.id === id)?.handler;
    case "webhook":
      return manifest.webhooks?.handlers.find((h) => h.event === id)?.handler;
    default:
      return undefined;
  }
}

/**
 * Get permissions for specific handler
 */
export function getHandlerPermissions(
  manifest: ManifestV3,
  host: HostType,
  id: string,
): PermissionSpec {
  // Get handler-specific permissions
  let handlerPerms: PermissionSpec | undefined;

  switch (host) {
    case "cli":
      handlerPerms = manifest.cli?.commands.find(
        (cmd) => cmd.path === id,
      )?.permissions;
      break;
    case "rest":
      handlerPerms =
        manifest.rest?.routes.find(
          (route) => `${route.method} ${route.path}` === id,
        )?.permissions ??
        manifest.sse?.streams.find((stream) => stream.path === id)?.permissions;
      break;
    case "ws":
      handlerPerms = manifest.ws?.channels.find(
        (ch) => ch.path === id,
      )?.permissions;
      break;
    case "workflow":
      handlerPerms = manifest.workflows?.handlers.find(
        (h) => h.id === id,
      )?.permissions;
      break;
    case "webhook":
      handlerPerms = manifest.webhooks?.handlers.find(
        (h) => h.event === id,
      )?.permissions;
      break;
  }

  // Merge with plugin-wide defaults
  return {
    ...manifest.permissions,
    ...handlerPerms,
  };
}

// ── Service Manifest ────────────────────────────────────────────────────────

/**
 * ServiceManifest describes a standalone HTTP/WebSocket service
 * that can be managed by kb-dev (start/stop/restart/health).
 *
 * Schema: `kb.service/1`
 *
 * Each service declares how to start itself, what port it listens on,
 * and what health check endpoint to probe. kb-create uses this to
 * generate `devservices.yaml` automatically after installation.
 *
 * @example
 * ```ts
 * export const manifest: ServiceManifest = {
 *   schema: 'kb.service/1',
 *   id: 'rest',
 *   name: 'REST API',
 *   version: '1.2.0',
 *   description: 'Platform REST API daemon',
 *   runtime: {
 *     entry: 'dist/index.js',
 *     port: 5050,
 *     healthCheck: '/api/v1/health',
 *   },
 *   dependsOn: ['qdrant'],
 * };
 * ```
 */
export interface ServiceManifest {
  /** Schema version identifier */
  schema: "kb.service/1";

  /** Unique service identifier (used as key in devservices.yaml) */
  id: string;

  /** Human-readable service name */
  name: string;

  /** Service version (semver) */
  version: string;

  /** Optional description */
  description?: string;

  /** Display metadata (reuses plugin DisplayMetadata) */
  display?: DisplayMetadata;

  /** How to run this service */
  runtime: ServiceRuntime;

  /** Service IDs this service depends on (for startup ordering) */
  dependsOn?: string[];

  /** Public URL identity and internal mount for a project-scoped service. */
  projectApi?: ProjectServiceApiDeclaration;

  /** Commands exposed by this service through project MCP. */
  commands?: ServiceCommandDeclaration[];

  /** Environment variables required/supported */
  env?: Record<string, ServiceEnvVar>;
}

/** A service-owned command contract consumed by CLI and project MCP. */
export type ServiceCommandDeclaration = ServiceCommandMetadata & (
  | { kind: "local" }
  | {
      kind: "service";
      route: ServiceCommandRouteDeclaration;
    }
);

export type ServiceCommandRouteDeclaration = {
  method: "GET" | "DELETE";
  path: string;
  mount: "project-api" | "service-root";
  body?: never;
} | {
  method: "POST" | "PUT" | "PATCH";
  path: string;
  mount: "project-api" | "service-root";
  body?: true;
};

interface ServiceCommandMetadata {
  name: string;
  description: string;
  flags: Record<string, { type: "string" | "boolean" | "number" | "array"; description?: string; required?: boolean }>;
  scope: "project" | "global";
  jsonTest: { safeArgs?: string[]; noSafeValidPath?: string };
  category: string;
  examples?: string[];
}

export interface ProjectServiceApiDeclaration {
  /** Unique URL segment after `/api/v1/projects/{projectId}`. */
  serviceId: string;
  /** Internal service mount prefix removed from its public project URL. */
  rewritePrefix: string;
}

/** Routing declaration enriched with the one health endpoint from the service runtime manifest. */
export interface ProjectServiceDeclaration extends ProjectServiceApiDeclaration {
  healthCheck: string;
}

/** Describes how kb-dev should start and monitor the service. */
export interface ServiceRuntime {
  /** Entrypoint relative to package root (e.g. "dist/index.js") */
  entry: string;

  /** Optional standalone TCP port; host-managed services receive an allocated address. */
  port?: number;

  /** Health check path (appended to http://localhost:<port>) */
  healthCheck: string;

  /** Protocol: "http" (default) or "ws" */
  protocol?: "http" | "ws";

  /**
   * Unix domain socket path declared by this service.
   * When set, kb-dev injects it as KB_SOCKET_PATH env var and uses it for health probes.
   * Convention: /tmp/kb-<projectHash>/<serviceName>.sock
   */
  socket?: string;
}

/** Describes an environment variable the service uses. */
export interface ServiceEnvVar {
  /** Description of what this env var controls */
  description?: string;
  /** Default value (if any) */
  default?: string;
  /** Whether the service requires this env var to start */
  required?: boolean;
}

/**
 * Type guard to check if manifest is a ServiceManifest.
 */
export function isServiceManifest(
  manifest: unknown,
): manifest is ServiceManifest {
  return (
    typeof manifest === "object" &&
    manifest !== null &&
    "schema" in manifest &&
    manifest.schema === "kb.service/1"
  );
}
