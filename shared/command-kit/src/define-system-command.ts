/**
 * @module @kb-labs/shared-command-kit
 * System Command Definition - For KB Labs official commands with full privileges
 */

import {
  type FlagSchemaDefinition,
  type InferFlags,
  defineFlags,
  validateFlags,
  FlagValidationError,
} from './index';
import type { CommandResult, PluginContextV3 } from '@kb-labs/plugin-contracts';
import type { PlatformContainer } from '@kb-labs/core-runtime';
import { formatError } from './errors/index';
import { createContextLogger, createErrorEnvelope, createProcessRootLogContext, createCatalogErrorEnvelope, logUnexpectedCliError, mapErrorEnvelopeToExitCode, toErrorEnvelope, type DetailsFor, type CatalogErrorRequest, type ErrorCode, type ErrorEnvelope, type PlatformErrorCode } from '@kb-labs/core-platform';
import { normalizeJsonResult } from '@kb-labs/plugin-runtime';
import { isUxResult } from '@kb-labs/core-platform/ux-result';
import { renderErrorEnvelope } from '@kb-labs/shared-cli-ui';

/**
 * Flag definition for Command interface
 */
interface FlagDefinition {
  name: string;
  type: 'string' | 'boolean' | 'number' | 'array';
  alias?: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  secret?: boolean;
  choices?: string[];
}

/**
 * Command definition for system commands
 */
export type SystemCommandContext = PluginContextV3 & {
  /** Internal system-command access to the already initialized execution backend. */
  executionBackend?: PlatformContainer['executionBackend'];
};

export interface Command {
  name: string;
  scope: CommandScope;
  /** Public access is explicit; system commands otherwise require a user session. */
  authProtection?: 'public' | 'session';
  /** Registry test fixture for the command's safe JSON success path. */
  jsonTest: SystemCommandJsonTest;
  describe: string;
  longDescription?: string;
  category?: string;
  aliases?: string[];
  flags?: FlagDefinition[];
  examples?: string[];
  run: (ctx: SystemCommandContext, argv: string[], flags: Record<string, unknown>) => Promise<number>;
}

export type CommandScope = 'platform' | 'project' |
  ((argv: readonly string[], flags: Readonly<Record<string, unknown>>) => 'platform' | 'project');

export type SystemCommandJsonTest =
  | { safeArgs: readonly string[] }
  | { noSafeValidPath: string };

const GLOBAL_FLAG_NAMES = new Set([
  'debug', 'dryRun', 'dry-run', 'help', 'json', 'logLevel', 'mock', 'noColor',
  'profile', 'profilesDir', 'quiet', 'recordMocks', 'saveSnapshot', 'verbose',
  'version',
]);

function validateSystemFlags(
  commandName: string,
  rawFlags: Record<string, unknown>,
  schema: FlagSchemaDefinition,
): void {
  const schemaNames = new Set(Object.keys(schema));
  for (const flagName of Object.keys(schema)) {
    schemaNames.add(flagName.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()));
  }
  for (const flagName of Object.keys(rawFlags)) {
    const normalizedName = flagName.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (schemaNames.has(flagName) || schemaNames.has(normalizedName) || GLOBAL_FLAG_NAMES.has(flagName)) continue;
    throw new FlagValidationError(
      flagName,
      `Unknown flag: --${flagName}`,
      rawFlags[flagName],
      schema,
      commandName,
    );
  }
}

function renderSystemFlagError(
  error: unknown,
  commandName: string,
  ctx: PluginContextV3,
  jsonMode: boolean,
  showStack: boolean,
): void {
  const formatted = formatError(error, { showStack, jsonMode });
  if (jsonMode && error instanceof FlagValidationError) {
    ctx.ui?.json({
      ok: false,
      error: createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', {
        cause: error.message,
        details: { field: `--${error.flag}` },
      }),
    });
  } else if (jsonMode) {
    ctx.ui?.json(formatted.json);
  } else {
    ctx.ui?.error(formatted.message);
  }
}

/**
 * Command group definition
 */
export interface CommandGroup {
  name: string;
  describe: string;
  commands: Command[];
  subgroups?: CommandGroup[];
}

/**
 * Convert flag schema definition to FlagDefinition[] format
 * Used for compatibility with Command interface
 */
function convertFlagSchema(schema: FlagSchemaDefinition): FlagDefinition[] {
  return Object.entries(schema).map(([name, def]) => {
    const result: FlagDefinition = {
      name,
      type: def.type,
      alias: def.alias,
      description: def.description,
      default: def.default,
      required: def.required,
      secret: def.secret,
    };

    // Add choices if present (for string flags with choices)
    if (def.type === 'string' && 'choices' in def && Array.isArray(def.choices)) {
      result.choices = [...def.choices];
    }

    return result;
  });
}

/**
 * Extended command config for system commands
 *
 * All type parameters are optional - use them when you want type safety, skip them for simplicity.
 *
 * TFlags can be inferred from the flags schema, but can also be explicitly provided
 * for better type inference in complex cases.
 *
 * TResult must extend CommandResult (requires ok: boolean field).
 */
export interface SystemCommandConfig<
  TFlags extends FlagSchemaDefinition = FlagSchemaDefinition,
  TResult extends CommandResult = CommandResult,
  TArgv extends readonly string[] = string[]
> {
  /** Command name (required for system commands) */
  name: string;
  /** Startup scope required before command execution. */
  scope: CommandScope;
  /** Public access is explicit; system commands otherwise require a user session. */
  authProtection?: 'public' | 'session';
  /** Registry test fixture or explicit reason this command has no safe valid path. */
  jsonTest: SystemCommandJsonTest;
  /** Command description (required for system commands) */
  description: string;
  /** Long description for help */
  longDescription?: string;
  /** Category (defaults to 'system') */
  category?: string;
  /** Command aliases */
  aliases?: string[];
  /** Usage examples */
  examples?: string[];
  /** Flag schema definition - TypeScript will infer TFlags from this */
  flags: TFlags;
  /**
   * Analytics configuration (legacy field, kept for backward compatibility)
   * Use ctx.platform.analytics.track() or withAnalytics() helper instead
   */
  analytics?: {
    command?: string;
    startEvent?: string;
    finishEvent?: string;
    actor?: string;
    context?: Record<string, unknown>;
    includeFlags?: boolean;
  };
  /** Command handler - receives PluginContextV3 and must return TResult */
  handler: (ctx: SystemCommandContext, argv: TArgv, flags: InferFlags<TFlags>) => Promise<number | TResult> | number | TResult;
  /** Optional formatter - receives TResult with inferred flags */
  formatter?: (result: TResult, ctx: SystemCommandContext, flags: InferFlags<TFlags>, argv?: TArgv) => void;
}

/**
 * Define a system command with full privileges
 *
 * System commands are KB Labs official commands that run with full system access,
 * bypassing sandbox restrictions. They are architecturally separated from plugin
 * commands - plugins can NEVER gain system privileges.
 *
 * TResult is REQUIRED - every command must explicitly declare its result contract.
 * This ensures type safety and enables future contract validation.
 *
 * @example
 * ```typescript
 * import { defineSystemCommand, type CommandResult, type FlagSchemaDefinition } from '@kb-labs/shared-command-kit';
 *
 * // Simple command with automatic flag type inference (RECOMMENDED)
 * export const helloCommand = defineSystemCommand<CommandResult & { message: string }>({
 *   name: 'hello',
 *   description: 'Print a friendly greeting',
 *   category: 'system',
 *   flags: {
 *     name: { type: 'string', description: 'Name to greet' },
 *     json: { type: 'boolean', default: false },
 *   } satisfies FlagSchemaDefinition, // Preserves literal types for type inference
 *   async handler(ctx, argv, flags) {
 *     // ctx is EnhancedCliContext (extends PluginContextV3)
 *     // ctx.cwd - working directory (V2 promoted field)
 *     // ctx.ui - UI output API with new convenience methods
 *     // flags.name is inferred as string | undefined
 *     const message = `Hello, ${flags.name || 'World'}!`;
 *
 *     // UI output (CLI only, no-op in REST/Workflow)
 *     if (!flags.json) {
 *       if (ctx.ui?.success) {
 *         ctx.ui.success('Greeting', [
 *           { items: [message] },
 *         ]);
 *       }
 *     }
 *
 *     return { message };
 *   },
 * });
 *
 * // Command with explicit result type and automatic flag inference
 * type WorkflowListResult = CommandResult & {
 *   workflows: Array<{ id: string }>;
 *   total: number;
 * };
 *
 * export const wfList = defineSystemCommand<WorkflowListResult>({
 *   name: 'list',
 *   description: 'List workflows',
 *   flags: {
 *     source: { type: 'string', default: 'all' },
 *     tag: { type: 'string' },
 *     json: { type: 'boolean', default: false },
 *   } satisfies FlagSchemaDefinition, // TypeScript infers flag types automatically
 *   async handler(ctx, argv, flags) {
 *     // flags.source is inferred as string
 *     // flags.tag is inferred as string | undefined
 *     // flags.json is inferred as boolean
 *     const workflows = await listWorkflows(flags.source, flags.tag);
 *
 *     // UI output (new convenience methods)
 *     if (!flags.json) {
 *       if (ctx.ui?.success) {
 *         ctx.ui.success('Workflows', [
 *           { header: 'Summary', items: [`Total: ${workflows.length}`, `Source: ${flags.source}`] },
 *           { items: workflows.map(w => `• ${w.id}`) },
 *         ]);
 *       }
 *     }
 *
 *     return { workflows, total: workflows.length };
 *   },
 * });
 *
 * // Command with explicit flag types (for complex cases)
 * export const wfRun = defineSystemCommand<
 *   { 'workflow-id': { type: 'string'; required: true } },
 *   CommandResult & { run: WorkflowRun }
 * >({
 *   name: 'run',
 *   description: 'Execute a workflow',
 *   flags: {
 *     'workflow-id': { type: 'string', required: true },
 *   },
 *   async handler(ctx, argv, flags) {
 *     // flags['workflow-id'] is inferred as string (required)
 *
 *     // Progress tracking (CLI only, no-op in REST/Workflow)
 *     ctx.ui?.startProgress('running', 'Starting workflow...');
 *     const run = await executeWorkflow(flags['workflow-id']);
 *     ctx.ui?.completeProgress('running', 'Workflow started!');
 *
 *     return { run };
 *   },
 * });
 *
 * // Note: System commands support all UI convenience methods:
 * // - ctx.ui.success() / showError() / warning() / info() - Result display with sideBox
 * // - ctx.ui.startProgress() / completeProgress() / failProgress() - Progress tracking
 * // - ctx.ui.table() / keyValue() / list() - Low-level formatting
 * // All UI methods are CLI-only and no-op in REST/Workflow contexts
 * ```
 */
// Overload for explicit TFlags and TResult
export function defineSystemCommand<
  TFlags extends FlagSchemaDefinition,
  TResult extends CommandResult = CommandResult,
  TArgv extends readonly string[] = string[]
>(
  config: SystemCommandConfig<TFlags, TResult, TArgv>
): Command;
// Implementation - all parameters optional with defaults
export function defineSystemCommand<
  TFlags extends FlagSchemaDefinition = FlagSchemaDefinition,
  TResult extends CommandResult = CommandResult,
  TArgv extends readonly string[] = string[]
>(
  config: SystemCommandConfig<TFlags, TResult, TArgv>
): Command {
  const { name, scope, authProtection, jsonTest, description, longDescription, category, aliases, examples, flags, handler, formatter } = config;

  // Return command with direct handler (no wrapping needed - system commands don't use V3 defineCommand)
  return {
    name,
    scope,
    authProtection,
    jsonTest,
    describe: description,
    longDescription,
    category: category || 'system',
    aliases: aliases || [],
    flags: flags ? convertFlagSchema(flags) : [],
    examples: examples || [],
    run: async (ctx: SystemCommandContext, argv: string[], rawFlags: Record<string, unknown>) => {
      const jsonMode = Boolean(rawFlags.json);

      // Log command start
      ctx.platform?.logger?.info?.(`Command ${name} started`);

      // Validate command flags and reject unknown flags before running handlers.
      let validatedFlags: InferFlags<TFlags>;

      if (flags) {
        const flagSchema = defineFlags(flags);
        try {
          validateSystemFlags(name, rawFlags, flags);
          validatedFlags = await validateFlags(rawFlags, flagSchema) as InferFlags<TFlags>;
        } catch (error) {
          // Enhance validation error with command name
          if (error instanceof FlagValidationError && name && !error.commandName) {
            (error as { commandName?: string }).commandName = name;
          }

          // Show stack trace only in debug mode
          renderSystemFlagError(error, name, ctx, jsonMode, Boolean(rawFlags.debug));

          // An undeclared option is invalid CLI usage, matching the shared
          // CLI usage exit code.
          return error instanceof FlagValidationError && error.message.startsWith('Unknown flag:') ? 2 : 3;
        }
      } else {
        try {
          validateSystemFlags(name, rawFlags, {});
        } catch (error) {
          renderSystemFlagError(error, name, ctx, jsonMode, Boolean(rawFlags.debug));
          return 2;
        }
        validatedFlags = rawFlags as InferFlags<TFlags>;
      }

      const handlerContext = ctx.ui
        ? {
          ...ctx,
          ui: {
            ...ctx.ui,
            json: () => { throw createContractViolation(); },
            error: () => { throw createContractViolation(); },
          },
        }
        : ctx;

      // Handlers return result data. The command boundary owns serialization.
      let result: number | TResult;
      try {
        result = await handler(handlerContext, argv as unknown as TArgv, validatedFlags);
        if (isCommandFailure(result)) {
          const envelope = toErrorEnvelope(result.error, {
            correlationId: ctx.requestId,
            ...(ctx.hostContext.host === 'cli' ? { binary: ctx.hostContext.binaryName } : {}),
          });
          if (jsonMode) {
            ctx.ui?.json({ ok: false, error: envelope });
          } else {
            ctx.ui?.error(renderErrorEnvelope(envelope), { hint: envelope.hint });
          }
          return mapErrorEnvelopeToExitCode(envelope.code);
        }
        if (isUxResult(result)) {
          throw createContractViolation();
        }
        if (isFailureClaim(result) && !isCommandFailure(result)) {
          throw createContractViolation();
        }
      } catch (error) {
        const envelope = toErrorEnvelope(error, {
          correlationId: ctx.requestId,
          ...(ctx.hostContext.host === 'cli' ? { binary: ctx.hostContext.binaryName } : {}),
        });
        if (envelope.code === 'KB_RUNTIME_UNEXPECTED') {
          if (ctx.platform?.logger) {
            const logger = createContextLogger(
              ctx.platform.logger,
              createProcessRootLogContext({
                applicationId: 'kb',
                serviceId: 'kb',
                instanceId: `${process.pid}`,
                layer: 'cli',
              }),
            ).forComponent('cli-error-boundary');
            logUnexpectedCliError(logger, error, envelope.correlationId);
          }
        }
        if (jsonMode) {
          ctx.ui?.json({ ok: false, error: envelope });
        } else {
          ctx.ui?.error(
            renderErrorEnvelope(envelope),
            { hint: envelope.hint },
          );
        }
        return mapErrorEnvelopeToExitCode(envelope.code);
      }

      if (jsonMode) {
        const output = typeof result === 'number' ? null : result ?? null;
        ctx.ui?.json(normalizeJsonResult(output));
      } else if (formatter && typeof result !== 'number' && result !== undefined && result !== null) {
        formatter(result as TResult, ctx, validatedFlags, argv as unknown as TArgv);
      }

      // Log command completion
      ctx.platform?.logger?.info?.(`Command ${name} completed`);

      // Convert result to exit code
      if (typeof result === 'number') {
        return result;
      }
      return 0;
    },
  };
}

function createContractViolation(): Error & { code: string; hint: string } {
  return Object.assign(new Error('Command handlers must return plain command data instead of writing JSON or envelope output directly.'), {
    code: 'KB_PLUGIN_CONTRACT_VIOLATION',
    hint: 'Return command data without an { ok: true, data: ... } envelope, or throw a typed command failure.',
  });
}

function isFailureClaim(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
}

function isCommandFailure(value: unknown): value is { ok: false; error: { code: ErrorCode; message: string; hint: string } } {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false
    && 'error' in value && value.error !== null && typeof value.error === 'object'
    && 'code' in value.error && typeof value.error.code === 'string'
    && 'message' in value.error && typeof value.error.message === 'string'
    && 'hint' in value.error && typeof value.error.hint === 'string';
}

export function throwSystemCommandError(
  message: string,
  hint: string,
  details?: DetailsFor<'KB_RUNTIME_COMMAND_FAILED'>,
  diagnostics?: ErrorEnvelope['diagnostics'],
): never {
  throw Object.assign(new Error(message), {
    code: 'KB_RUNTIME_COMMAND_FAILED',
    hint,
    ...(details ? { details } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  });
}

export function throwSystemCataloguedFailure(request: CatalogErrorRequest): never {
  throwSystemCataloguedError(createCatalogErrorEnvelope(request));
}

export function throwSystemCataloguedError(envelope: ErrorEnvelope): never {
  throw Object.assign(new Error(envelope.message), {
    code: envelope.code,
    hint: envelope.hint,
    ...(envelope.cause ? { cause: envelope.cause } : {}),
    ...(envelope.details ? { details: envelope.details } : {}),
    ...(envelope.diagnostics ? { diagnostics: envelope.diagnostics } : {}),
    ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}),
  });
}

/**
 * Create a system command group
 *
 * Groups organize related system commands for better help organization
 * and registration.
 *
 * @example
 * ```typescript
 * export const systemInfoGroup = defineSystemCommandGroup(
 *   'system:info',
 *   'System information commands',
 *   [helloCommand, versionCommand, healthCommand]
 * );
 * ```
 */
export function defineSystemCommandGroup(
  name: string,
  describe: string,
  commands: Command[]
): CommandGroup {
  return {
    name,
    describe,
    commands,
  };
}
