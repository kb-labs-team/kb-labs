/**
 * @module @kb-labs/core-sandbox/runner/context/context-recreator
 * Recreate ExecutionContext from serialized IPC data
 */

import type { ExecutionContext } from "../../types/index";
import type { SerializableContext } from "../ipc-serializer";
import type {
  CliHandlerContext,
  RestHandlerContext,
} from "../../types/adapter-context";
import type { Output } from "@kb-labs/core-sys/output";
import { createSandboxOutput } from "../../output/index";
import { initializeSubprocessLogging } from "../initialization/logging-setup";

export interface ContextRecreatorOptions {
  serializedCtx: SerializableContext;
  sandboxOutput: Output;
  debugMode?: boolean;
}

/**
 * Recreate shims and adapter context from serialized context
 *
 * Functions cannot be serialized via IPC, so we recreate them in subprocess:
 * - remainingMs() - returns 0 (subprocess doesn't know parent timeout)
 * - analytics - undefined (not supported in subprocess)
 * - onLog - undefined (logs go through stdout/stderr)
 * - signal - undefined (cancellation through IPC)
 * - resources - undefined (cleanup in parent process)
 *
 * Also recreates adapter context (CLI/REST) with proper Output and Presenter shims.
 *
 * @param options - Recreation options
 * @returns ExecutionContext with recreated functions and adapters
 * @throws Error if pluginRoot is missing
 */
export async function recreateContext(
  options: ContextRecreatorOptions,
): Promise<ExecutionContext> {
  const { serializedCtx, sandboxOutput, debugMode = false } = options;

  // Ensure pluginRoot is set (required)
  if (!serializedCtx || !serializedCtx.pluginRoot) {
    throw new Error("pluginRoot is required in SerializableContext");
  }

  // Initialize platform in worker if config provided
  if (serializedCtx.platformConfig) {
    if (!serializedCtx.platformRoot || serializedCtx.workspaceDevelopment === undefined) {
      throw new Error('platformRoot and workspaceDevelopment are required when a sandbox worker initializes platform adapters.');
    }
    const { initPlatform } = await import("@kb-labs/core-runtime");
    const cwd = serializedCtx.workdir || serializedCtx.pluginRoot || process.cwd();
    await initPlatform(
      serializedCtx.platformConfig,
      cwd,
      undefined,
      serializedCtx.platformRoot,
      { workspaceDevelopment: serializedCtx.workspaceDevelopment, workspaceRoot: serializedCtx.platformRoot },
    );

    if (debugMode) {
      sandboxOutput.debug("Platform initialized in worker", {
        adapters: Object.keys(serializedCtx.platformConfig.adapters ?? {}),
        platformRoot: serializedCtx.platformRoot,
        workspaceDevelopment: serializedCtx.workspaceDevelopment,
      });
    }
  }

  // Set __KB_CONFIG_SECTION__ for useConfig() auto-detection
  if (serializedCtx.configSection) {
    (
      globalThis as typeof globalThis & { __KB_CONFIG_SECTION__?: unknown }
    ).__KB_CONFIG_SECTION__ = serializedCtx.configSection;
  }

  // Defensive: ensure serializedCtx has all required fields
  const ctx: ExecutionContext = {
    requestId: serializedCtx.requestId || "",
    workdir: serializedCtx.workdir || "",
    outdir: serializedCtx.outdir,
    pluginRoot: serializedCtx.pluginRoot, // Required field
    pluginId: serializedCtx.pluginId || "",
    pluginVersion: serializedCtx.pluginVersion || "",
    configSection: serializedCtx.configSection, // For useConfig() auto-detection
    traceId: serializedCtx.traceId,
    spanId: serializedCtx.spanId,
    parentSpanId: serializedCtx.parentSpanId,
    debug: serializedCtx.debug || false,
    debugLevel: serializedCtx.debugLevel, // Can be undefined, which is fine
    dryRun: serializedCtx.dryRun || false,
    user: serializedCtx.user,
    // Recreate functions as no-ops or IPC forwarders
    remainingMs: () => 0, // subprocess не знает о родительском timeout
    analytics: undefined, // не поддерживается в subprocess
    onLog: undefined, // логи идут через stdout/stderr
    signal: undefined, // cancellation через IPC
    resources: undefined, // cleanup в родительском процессе
    adapterMeta: serializedCtx.adapterMeta,
    version: serializedCtx.version,
  };

  // Recreate adapter context if needed
  if (serializedCtx.adapterContextData) {
    const data = serializedCtx.adapterContextData;
    if (debugMode) {
      sandboxOutput.debug(
        `adapterContextData received: type=${data.type}, hasFlags=${!!data.flags}`,
      );
    }
    if (data.type === "cli") {
      // Create Output for plugin in subprocess
      const pluginOutput = createSandboxOutput({
        verbosity: ctx.debug ? "debug" : "normal",
        category: `plugin:${ctx.pluginId || "unknown"}`,
        format: "human",
        context: {
          plugin: ctx.pluginId,
          command:
            ctx.adapterMeta?.signature === "command" ? "command" : undefined,
          trace: ctx.traceId,
        },
      });

      // Presenter в subprocess логирует через console/IPC (для обратной совместимости)
      ctx.adapterContext = {
        type: "cli",
        output: pluginOutput,
        presenter: {
          write: (text: string) => pluginOutput.write(text),
          error: (text: string) => pluginOutput.error(text),
          info: (text: string) => pluginOutput.info(text),
          json: (data: unknown) => pluginOutput.json(data),
        },
        cwd: (data.cwd as string) || ctx.workdir,
        flags: (data.flags as Record<string, unknown>) || {},
        argv: (data.argv as string[]) || [],
        requestId: ctx.requestId,
        workdir: ctx.workdir,
        outdir: ctx.outdir,
        pluginId: ctx.pluginId,
        pluginVersion: ctx.pluginVersion,
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        parentSpanId: ctx.parentSpanId,
        debug: ctx.debug,
      } as CliHandlerContext;
    } else if (data.type === "rest") {
      ctx.adapterContext = {
        type: "rest",
        request: data.request,
        requestId: ctx.requestId,
        workdir: ctx.workdir,
        outdir: ctx.outdir,
        pluginId: ctx.pluginId,
        pluginVersion: ctx.pluginVersion,
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        parentSpanId: ctx.parentSpanId,
        debug: ctx.debug,
      } as RestHandlerContext;
    }

    // Add logger to CLI context using subprocess logger
    // IMPORTANT: Use getSubprocessLogger() instead of getLogger() to ensure
    // the logger respects KB_LOG_LEVEL from parent process
    if (ctx.adapterContext?.type === "cli") {
      const cliCtx = ctx.adapterContext as CliHandlerContext;
      // Use subprocess logger (already initialized with parent's KB_LOG_LEVEL)
      try {
        const { getSubprocessLogger } = initializeSubprocessLogging();
        const logger = getSubprocessLogger().child({
          meta: {
            layer: "plugin",
            requestId: ctx.requestId,
            traceId: ctx.traceId,
            spanId: ctx.spanId,
            parentSpanId: ctx.parentSpanId,
            pluginId: ctx.pluginId,
            pluginVersion: ctx.pluginVersion,
          },
        });

        // Add logger to context (for direct use by plugins)
        // Plugins MUST use ctx.logger, not getLogger() directly
        cliCtx.logger = logger;
      } catch {
        // If logging system not available, logger will be undefined
        // Plugins should check ctx.logger before using
      }
    }
  }

  // Recreate extensions (only serializable data)
  if (serializedCtx.extensionsData) {
    ctx.extensions = {
      ...(ctx.extensions ?? {}),
      ...serializedCtx.extensionsData,
    };
  }

  return ctx;
}
