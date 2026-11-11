/**
 * Manifest helpers — optional, additive utilities for reducing boilerplate.
 *
 * Manifests can always be written as plain TypeScript literal objects.
 * These helpers exist purely to cut repetition in the CLI commands and REST
 * routes sections, which are the two highest-density areas.
 *
 * Inspired by:
 *   - Commander.js  → cmd() fluent builder for CLI commands
 *   - Hono          → GET/POST/... standalone functions for HTTP routes
 *   - Vite          → createManifest() thin wrapper for type safety
 */

import type {
  ManifestV3,
  CliCommandDecl,
  CliGroupMeta,
  RestRouteDecl,
  WebhookHandlerDecl,
  WebhookAuthConfig,
  PermissionSpec,
} from '@kb-labs/plugin-contracts';
import { defineCommandFlags } from './manifest.js';

// ─── Branded types ────────────────────────────────────────────────────────────

/** Plugin identifier: must follow `@scope/name` format */
export type PluginId = `@${string}/${string}`;

/** Semver string: `major.minor.patch[suffix]` */
export type SemVer = `${number}.${number}.${number}${string}`;

/**
 * Handler file reference.
 * Must start with `./` and end with `.js` (optionally with `#exportName`).
 * @example './commands/health.js'
 * @example './commands/health.js#default'
 */
export type HandlerRef =
  | `./${string}.js`
  | `./${string}.js#${string}`;

/** Base path for REST routes under the gateway. */
export type RestBase = `/v1/plugins/${string}`;

/** Base path for WebSocket channels. */
export type WsBase = `/v1/ws/plugins/${string}`;

// ─── Flag schema (narrow subset that defineCommandFlags accepts) ───────────────

type ManifestFlagDef = Record<
  string,
  {
    type: 'string' | 'boolean' | 'number' | 'array';
    alias?: string;
    default?: unknown;
    description?: string;
    choices?: string[];
    required?: boolean;
  }
>;

// ─── CLI helpers ──────────────────────────────────────────────────────────────

/** Internal mutable state for CmdBuilder */
interface CmdState {
  path: string;
  handler: string;
  describe: string;
  operationType?: CliCommandDecl['operationType'];
  longDescription?: string;
  flags?: CliCommandDecl['flags'];
  examples?: string[];
  category?: string;
  aliases?: string[];
  permissions?: PermissionSpec;
}

/**
 * Fluent builder for a single CLI command declaration.
 *
 * Constructed via `cmd()` — not instantiated directly.
 *
 * @example
 * ```ts
 * cmd('workflow health', './commands/health.js#default', 'Check daemon health.')
 *   .read()
 *   .flags(healthFlags)
 *   .examples(['kb workflow health', 'kb workflow health --json'])
 * ```
 */
export class CmdBuilder {
  private readonly _state: CmdState;

  constructor(path: string, handler: string, describe: string) {
    this._state = { path, handler, describe };
  }

  /** operationType: 'read' — auto-injects --output, --limit, --offset */
  read(): this {
    this._state.operationType = 'read';
    return this;
  }

  /** operationType: 'mutate' — auto-injects --output, --dry-run, --yes */
  mutate(): this {
    this._state.operationType = 'mutate';
    return this;
  }

  /** operationType: 'execute' — auto-injects --output, --wait, --watch, --timeout, --yes */
  execute(): this {
    this._state.operationType = 'execute';
    return this;
  }

  /** operationType: 'analyze' — auto-injects --output, --format, --stream */
  analyze(): this {
    this._state.operationType = 'analyze';
    return this;
  }

  /**
   * Define command flags.
   * Calls `defineCommandFlags()` internally — no need to wrap manually.
   */
  flags(def: ManifestFlagDef): this {
    this._state.flags = defineCommandFlags(def);
    return this;
  }

  /** Long description shown in `--help` output. */
  long(text: string): this {
    this._state.longDescription = text;
    return this;
  }

  /** Usage examples shown in `--help` output. */
  examples(list: string[]): this {
    this._state.examples = list;
    return this;
  }

  /**
   * Display category label.
   * When using `group()`, the group's `category` is applied to commands
   * that don't have their own category set.
   */
  category(cat: string): this {
    this._state.category = cat;
    return this;
  }

  /** Alternative full paths for this command. */
  aliases(list: string[]): this {
    this._state.aliases = list;
    return this;
  }

  /** Command-specific permissions (override plugin defaults). */
  perms(spec: PermissionSpec): this {
    this._state.permissions = spec;
    return this;
  }

  /** Build the final `CliCommandDecl`. */
  build(): CliCommandDecl {
    const decl: CliCommandDecl = {
      path: this._state.path,
      handler: this._state.handler,
      describe: this._state.describe,
    };
    if (this._state.operationType !== undefined) { decl.operationType = this._state.operationType; }
    if (this._state.longDescription !== undefined) { decl.longDescription = this._state.longDescription; }
    if (this._state.flags !== undefined) { decl.flags = this._state.flags; }
    if (this._state.examples !== undefined) { decl.examples = this._state.examples; }
    if (this._state.category !== undefined) { decl.category = this._state.category; }
    if (this._state.aliases !== undefined) { decl.aliases = this._state.aliases; }
    if (this._state.permissions !== undefined) { decl.permissions = this._state.permissions; }
    return decl;
  }
}

/**
 * Create a CLI command builder.
 *
 * Three required positional args cover the most repetitive fields.
 * Everything else is chained: `.read()`, `.flags(def)`, `.examples([...])`.
 *
 * Eliminates:
 *   - `operationType: 'read' as const`  → `.read()`
 *   - `flags: defineCommandFlags(def)`  → `.flags(def)`
 *   - repeated `category: 'X'`         → set once in `group()`
 *
 * @example
 * ```ts
 * cmd('workflow health', './commands/health.js#default', 'Check daemon health.')
 *   .read()
 *   .flags(healthFlags)
 *   .examples(['kb workflow health'])
 * ```
 */
export function cmd(
  path: string,
  handler: HandlerRef,
  describe: string,
): CmdBuilder {
  return new CmdBuilder(path, handler, describe);
}

// ─── Group helpers ────────────────────────────────────────────────────────────

/** Result of `group()` — passed to `mergeCliGroups()` or spread manually. */
export interface CliGroup {
  meta: CliGroupMeta;
  commands: CliCommandDecl[];
}

/**
 * Group a set of commands under a shared `groupMeta` entry.
 *
 * If `meta.category` is provided, it is applied to every command inside
 * that does not already have its own category set.
 *
 * @example
 * ```ts
 * const runsGroup = group(
 *   { path: 'workflow runs', describe: 'Run management', category: 'Runs' },
 *   [
 *     cmd('workflow runs list', './commands/runs-list.js#default', 'List runs.').read().flags(runsListFlags),
 *     cmd('workflow runs view', './commands/runs-view.js#default', 'View run details.').read().flags(runsViewFlags),
 *   ]
 * );
 * ```
 */
export function group(
  meta: { path: string; describe: string; category?: string },
  cmds: Array<CmdBuilder | CliCommandDecl>,
): CliGroup {
  const commands = cmds.map((c) => {
    const decl = c instanceof CmdBuilder ? c.build() : c;
    if (meta.category !== undefined && decl.category === undefined) {
      return { ...decl, category: meta.category };
    }
    return decl;
  });
  return {
    meta: { path: meta.path, describe: meta.describe },
    commands,
  };
}

/**
 * Merge multiple `CliGroup` results into a single `cli` section object.
 *
 * @example
 * ```ts
 * cli: mergeCliGroups(daemonGroup, jobsGroup, runsGroup),
 * // → { commands: [...all commands], groupMeta: [...all group metas] }
 * ```
 */
export function mergeCliGroups(
  ...groups: CliGroup[]
): Required<ManifestV3>['cli'] {
  return {
    commands: groups.flatMap((g) => g.commands),
    groupMeta: groups.map((g) => g.meta),
  };
}

// ─── HTTP route helpers ───────────────────────────────────────────────────────

type RouteOpts = Omit<RestRouteDecl, 'method' | 'path' | 'handler'>;

function routeHelper(
  method: RestRouteDecl['method'],
  path: string,
  handler: HandlerRef,
  opts?: RouteOpts,
): RestRouteDecl {
  return { method, path, handler, ...opts };
}

/**
 * Declare a GET route.
 * @example GET(ROUTES.STATS, './rest/stats.js#default', { describe: 'Get stats' })
 */
export const GET = (path: string, handler: HandlerRef, opts?: RouteOpts): RestRouteDecl =>
  routeHelper('GET', path, handler, opts);

/**
 * Declare a POST route.
 * @example POST(ROUTES.RUN, './rest/run.js#default', { describe: 'Run workflow' })
 */
export const POST = (path: string, handler: HandlerRef, opts?: RouteOpts): RestRouteDecl =>
  routeHelper('POST', path, handler, opts);

/**
 * Declare a PUT route.
 */
export const PUT = (path: string, handler: HandlerRef, opts?: RouteOpts): RestRouteDecl =>
  routeHelper('PUT', path, handler, opts);

/**
 * Declare a PATCH route.
 */
export const PATCH = (path: string, handler: HandlerRef, opts?: RouteOpts): RestRouteDecl =>
  routeHelper('PATCH', path, handler, opts);

/**
 * Declare a DELETE route.
 */
export const DELETE = (path: string, handler: HandlerRef, opts?: RouteOpts): RestRouteDecl =>
  routeHelper('DELETE', path, handler, opts);

// ─── Webhook handler helpers ──────────────────────────────────────────────────

type WebhookOpts = Omit<WebhookHandlerDecl, 'event' | 'handler'>;

/**
 * Declare a webhook handler in the plugin manifest.
 *
 * `auth` is required at the call site — the gateway will refuse to start if
 * any webhook handler has no auth config.
 *
 * @example
 * ```ts
 * webhook('alert', './webhooks/alert.js#default', {
 *   auth: { type: 'secret', header: 'X-Webhook-Secret' },
 *   async: true,
 * })
 * ```
 */
export function webhook(
  event: string,
  handler: HandlerRef,
  opts: WebhookOpts & { auth: WebhookAuthConfig },
): WebhookHandlerDecl {
  return { event, handler, ...opts };
}

// ─── Manifest entry point ─────────────────────────────────────────────────────

/**
 * Create a type-safe `ManifestV3`.
 *
 * Provides branded-type validation for `id` and `version`, and
 * automatically injects `schema: 'kb.plugin/3'`.
 * Everything else is a plain literal object — no fluent chain.
 *
 * Writing manifests as plain object literals without this wrapper
 * is always valid.
 *
 * Built-in workflow routes use the project-scoped service contract instead
 * of a plugin manifest base path:
 *
 * @example
 * ```ts
 * import { projectWorkflowRoute, WORKFLOW_ROUTES } from '@kb-labs/workflow-contracts/routes'
 *
 * const statsPath = projectWorkflowRoute(projectId, WORKFLOW_ROUTES.STATS)
 * ```
 *
 * @example
 * ```ts
 * export const manifest = createManifest('@kb-labs/example', '1.0.0', {
 *   display: { name: 'Example' },
 *   cli: exampleGroup,
 *   rest: {
 *     basePath: '/v1/plugins/example',
 *     routes: [
 *       GET(ROUTES.STATS, './rest/stats.js#default', { describe: 'Dashboard stats' }),
 *     ],
 *   },
 *   permissions: pluginPermissions,
 * });
 * ```
 */
export function createManifest(
  id: PluginId,
  version: SemVer,
  body: Omit<ManifestV3, 'id' | 'version' | 'schema'>,
): ManifestV3 {
  return {
    schema: 'kb.plugin/3',
    id,
    version,
    ...body,
  };
}
