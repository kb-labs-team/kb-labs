/**
 * Plugin Executor
 *
 * Executes plugin commands via the V3 execution pipeline.
 */

import type { SystemContext } from "@kb-labs/cli-runtime";
import { executeCommandV3 } from "@kb-labs/cli-runtime/v3";
import type {
  UIFacade,
  PlatformServices,
  FSShim,
  PluginAPI,
} from "@kb-labs/plugin-contracts";
import {
  getHandlerPermissions,
  matchesPermissionPattern,
  noopTraceContext,
  noopUI,
} from "@kb-labs/plugin-contracts";
import type { PlatformContainer } from "@kb-labs/core-runtime";
import { randomUUID } from "node:crypto";
import { setJsonMode } from "@kb-labs/shared-cli-ui";
import {
  AdapterUnavailableError,
  createContextLogger,
} from "@kb-labs/core-platform";
import type { RegisteredCommand } from "@kb-labs/cli-commands";
import { resolveCliHandlerPath } from "@kb-labs/core-platform";
import type { PluginContextV3 } from "@kb-labs/plugin-contracts";
import { cliBinaryName } from './cli-binary.js';
import { createCLIUIFacade } from "./ui-facade";
import { missingCliResultWriter, type CliResultWriter } from './result-serializer.js';

export interface PluginExecutionOptions {
  context: SystemContext;
  env: NodeJS.ProcessEnv;
  commandId: string;
  argv: string[];
  flags: Record<string, unknown>;
  manifestCmd?: RegisteredCommand;
  platform: PlatformContainer;
  resultWriter?: CliResultWriter;
}

/**
 * Execute a plugin command.
 *
 * Returns exitCode on success, undefined if the command could not be executed
 * (missing manifest, missing handlerPath, etc.).
 */
export async function executePlugin(
  options: PluginExecutionOptions,
): Promise<number | undefined> {
  const { context, env, commandId, argv, flags, manifestCmd, platform } = options;
  const resultWriter = options.resultWriter ?? missingCliResultWriter;

  // No manifest command info - can't execute
  if (!manifestCmd) {
    return undefined;
  }

  const pluginManifest = manifestCmd.manifest.v3Manifest;
  if (!pluginManifest) {
    return undefined;
  }

  // Find CLI command definition by full path (e.g. 'clickup task search')
  const commandPath = manifestCmd.manifest.segments.join(" ");
  const cliCommand = pluginManifest.cli?.commands?.find(
    (c) => c.path === commandPath,
  );
  if (!cliCommand) {
    return undefined;
  }

  // Resolve handler path from handler field
  const handlerRelativePath = cliCommand.handler.split("#")[0];
  if (!handlerRelativePath) {
    return undefined;
  }

  const pluginRoot = manifestCmd.pkgRoot;
  if (!pluginRoot) {
    return undefined;
  }

  // Handler path should point to dist/ (compiled output)
  const handlerPath = resolveCliHandlerPath(pluginRoot, cliCommand.handler);
  const permissions = getHandlerPermissions(
    pluginManifest,
    "cli",
    commandPath,
  );

  // Gateway-aware plugins declare the address in their environment
  // permissions. The CLI bootstrap resolves the installed platform address
  // once for built-ins and plugins alike.
  const gatewayUrl = permissionAllowsEnvironmentVariable(
    permissions.env?.read,
    "KB_GATEWAY_URL",
  )
    ? env.KB_GATEWAY_URL
    : undefined;

  try {
    const pluginId = pluginManifest.id || manifestCmd.manifest.id;
    const pluginVersion = pluginManifest.version || "0.0.0";

    // When --json is active, suppress all UI output except json() to keep stdout clean.
    const jsonMode = Boolean(flags.json);
    // context.presenter (PresenterV1) is a broader runtime object that is
    // structurally compatible with PresenterDelegate at runtime even though
    // the static types differ (PresenterV1 exposes write/info/warn/error/json,
    // PresenterDelegate exposes debug/spinner/table — the runtime impl has all).
    let ui = createCLIUIFacade(
      context.presenter as unknown as Parameters<typeof createCLIUIFacade>[0],
      resultWriter,
    );
    if (jsonMode) {
      setJsonMode(true);
      ui = createJsonModeUI(ui);
    }

    const platformServices = createPlatformServices(platform);
    const quotas = permissions?.quotas;

    // Execute plugin. Pass the discovered `pkgRoot` explicitly so project-
    // scope plugins (whose node_modules live at
    // `<projectRoot>/.kb/plugins/<name>/node_modules/`, not under cwd) are
    // resolved correctly by the execution backend.
    try {
      const exitCode = await executeCommandV3({
          binaryName: cliBinaryName,
          pluginId,
          pluginVersion,
          commandPath,
          pluginRoot,
          handlerPath,
          argv,
          flags,
          ui,
          platform: platformServices,
          platformContainer: platform,
          cwd: context.cwd || process.cwd(),
          devMode: process.env.NODE_ENV === "development",
          permissions,
          quotas,
          configSection: pluginManifest.configSection,
          ...(gatewayUrl ? { env: { KB_GATEWAY_URL: gatewayUrl } } : {}),
        });

      context.logger?.debug(
        "[plugin-executor] Command executed via platform.executionBackend",
        {
          pluginId,
          exitCode,
          hasBackend: !!platform.executionBackend,
        },
      );

      return exitCode;
    } finally {
      if (jsonMode) {
        setJsonMode(false);
      }
    }
  } catch (error) {
    context.logger?.error(
      "[plugin-executor] Plugin execution failed",
      undefined,
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    );
    if (renderUnavailableAdapterError(
      error,
      context.presenter as unknown as Parameters<typeof createCLIUIFacade>[0],
      resultWriter,
    )) {
      return 1;
    }
    return undefined;
  }
}

function permissionAllowsEnvironmentVariable(
  patterns: string[] | undefined,
  variable: string,
): boolean {
  return patterns?.some((pattern) => matchesPermissionPattern(variable, pattern)) ?? false;
}

export function renderUnavailableAdapterError(
  error: unknown,
  presenter?: Parameters<typeof createCLIUIFacade>[0],
  resultWriter: CliResultWriter = missingCliResultWriter,
): boolean {
  if (!(error instanceof AdapterUnavailableError) || error.reason !== "not-configured") {
    return false;
  }
  createCLIUIFacade(presenter, resultWriter).error(error);
  return true;
}

/**
 * Route human progress through the JSON-aware facade, which sends it to stderr.
 * The command result itself is emitted once by the shared CLI executor.
 */
function createJsonModeUI(base: UIFacade): UIFacade {
  return {
    ...noopUI,
    colors: base.colors,
    symbols: base.symbols,
    write: base.write,
    info: base.info,
    success: base.success,
    warn: base.warn,
    debug: base.debug,
    spinner: base.spinner,
    table: base.table,
    newline: base.newline,
    divider: base.divider,
    box: base.box,
    json: base.json,
  };
}

/**
 * Create PlatformServices from platform container.
 */
function createPlatformServices(
  platformContainer: PlatformContainer,
): PlatformServices {
  return {
    logger: platformContainer.logger,
    llm: platformContainer.llm,
    embeddings: platformContainer.embeddings,
    vectorStore: platformContainer.vectorStore,
    cache: platformContainer.cache,
    config: platformContainer.config,
    storage: platformContainer.storage,
    analytics: platformContainer.analytics,
    eventBus: platformContainer.eventBus,
    invoke: platformContainer.invoke,
    documentDatabase: platformContainer.documentDatabase,
    kvStore: platformContainer.kvStore,
    logs: platformContainer.logs,
  };
}

/**
 * Create PluginContextV3 for system commands.
 *
 * Converts SystemContext → PluginContextV3.
 * Used by system commands (hello, version, etc.) to receive a full V3 context.
 */
export function createSystemCommandContext(
  context: SystemContext,
  platform: PlatformContainer,
  env: NodeJS.ProcessEnv,
  resolvePlatformVersion: () => Promise<string>,
  resultWriter: CliResultWriter = missingCliResultWriter,
): PluginContextV3 & { executionBackend?: PlatformContainer['executionBackend'] } {
  const ui = createCLIUIFacade(
    context.presenter as unknown as Parameters<typeof createCLIUIFacade>[0],
    resultWriter,
  );
  const requestId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const traceId = `trace-${randomUUID()}`;
  const spanId = `span-${randomUUID()}`;
  const invocationId = `inv-${randomUUID()}`;
  const executionId = `exec-${randomUUID()}`;

  const platformServices = createPlatformServices(platform);
  const scopedPlatformServices: PlatformServices = {
    ...platformServices,
    logger: createContextLogger(platformServices.logger, {
      applicationId: "kb",
      serviceId: "kb",
      instanceId: `${process.pid}`,
      layer: "cli",
    })
      .forComponent("plugin-executor")
      .forOperation("plugin.execute", {
        requestId,
        traceId,
        spanId,
      })
      .with({ invocationId, executionId })
      .forPlugin({ pluginId: "@kb-labs/system" }),
  };

  return {
    host: "cli",
    requestId,
    pluginId: "@kb-labs/system",
    cwd: context.cwd || process.cwd(),
    ui,
    platform: scopedPlatformServices,
    ...(platform.hasExecutionBackend ? { executionBackend: platform.executionBackend } : {}),
    runtime: {
      // The built-in command path shares the invocation environment carrier
      // with plugin handlers, without mutating the CLI process environment.
      fs: {} as unknown as FSShim,
      fetch: fetch,
      env: (key: string) => env[key],
    },
    api: {} as unknown as PluginAPI,
    hostContext: {
      host: "cli" as const,
      binaryName: cliBinaryName,
      argv: process.argv.slice(2),
      flags: {},
      resolvePlatformVersion,
    },
    pluginVersion: "1.0.0",
    trace: {
      ...noopTraceContext,
      traceId,
      spanId,
    },
  };
}
