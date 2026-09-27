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
  noopTraceContext,
  noopUI,
} from "@kb-labs/plugin-contracts";
import type { PlatformContainer } from "@kb-labs/core-runtime";
import { setJsonMode } from "@kb-labs/shared-cli-ui";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createContextLogger } from "@kb-labs/core-platform";
import type { RegisteredCommand } from "@kb-labs/cli-commands";
import type { PluginContextV3 } from "@kb-labs/plugin-contracts";
import { createCLIUIFacade } from "./ui-facade";
import { getLLMRouterMetadata } from "@kb-labs/core-platform";

export interface PluginExecutionOptions {
  context: SystemContext;
  commandId: string;
  argv: string[];
  flags: Record<string, unknown>;
  manifestCmd?: RegisteredCommand;
  platform: PlatformContainer;
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
  const { context, commandId, argv, flags, manifestCmd, platform } = options;

  // No manifest command info - can't execute
  if (!manifestCmd) {
    return undefined;
  }

  // Get plugin manifest (with fallback to legacy manifestV2 field)
  const pluginManifest =
    manifestCmd.v3Manifest ?? manifestCmd.manifest.manifestV2;
  if (!pluginManifest) {
    return undefined;
  }

  // Find CLI command definition by full path (e.g. 'clickup task search')
  const commandPath = manifestCmd.manifest.segments.join(" ");
  const cliCommand = pluginManifest.cli?.commands?.find(
    (c) => c.path === commandPath,
  );

  // Resolve handler path from handler field
  const handlerRelativePath = cliCommand?.handler?.split("#")[0];
  if (!handlerRelativePath) {
    return undefined;
  }

  const pluginRoot = manifestCmd.pkgRoot;
  if (!pluginRoot) {
    return undefined;
  }

  // Handler path should point to dist/ (compiled output)
  const handlerPath = handlerRelativePath.startsWith("dist/")
    ? path.resolve(pluginRoot, handlerRelativePath)
    : path.resolve(pluginRoot, "dist", handlerRelativePath);

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
    );
    if (jsonMode) {
      setJsonMode(true);
      ui = createJsonModeUI(ui);
    }

    const platformServices = createPlatformServices(platform);
    const socketPath = platform.getSocketPath();
    const permissions = getHandlerPermissions(
      pluginManifest,
      "cli",
      commandPath,
    );
    const quotas = permissions?.quotas;

    // Execute plugin. Pass the discovered `pkgRoot` explicitly so project-
    // scope plugins (whose node_modules live at
    // `<projectRoot>/.kb/plugins/<name>/node_modules/`, not under cwd) are
    // resolved correctly by the execution backend.
    try {
      const exitCode = await executeCommandV3({
        pluginId,
        pluginVersion,
        pluginRoot,
        handlerPath,
        argv,
        flags,
        ui,
        platform: platformServices,
        platformContainer: platform,
        socketPath,
        cwd: context.cwd || process.cwd(),
        devMode: process.env.NODE_ENV === "development",
        permissions,
        quotas,
        configSection: pluginManifest.configSection,
        llmRouting: await getLLMRouterMetadata(platform.llm, platform.logger),
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
      },
    );
    return undefined;
  }
}

/** Expose only routing metadata to workers; provider credentials/config stay in the parent. */
/**
 * Return a UIFacade that suppresses all output except json().
 * Used when --json flag is active to keep stdout clean for machine parsing.
 */
function createJsonModeUI(base: UIFacade): UIFacade {
  return {
    ...noopUI,
    colors: base.colors,
    symbols: base.symbols,
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
): PluginContextV3 {
  const ui = createCLIUIFacade(
    context.presenter as unknown as Parameters<typeof createCLIUIFacade>[0],
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
    runtime: {
      // Stub: system commands do not use sandboxed runtime. Real runtime is
      // only wired for plugin handlers executed via executeCommandV3.
      fs: {} as unknown as FSShim,
      fetch: fetch,
      env: (key: string) => process.env[key],
    },
    api: {} as unknown as PluginAPI,
    hostContext: {
      host: "cli" as const,
      argv: process.argv.slice(2),
      flags: {},
      // CLI_VERSION is injected from package.json in bin.ts at startup.
      cliVersion: process.env.CLI_VERSION ?? "0.0.0",
    },
    pluginVersion: "1.0.0",
    trace: {
      ...noopTraceContext,
      traceId,
      spanId,
    },
  };
}
