/**
 * V3 CLI Command Execution
 *
 * Entry point for executing plugin commands via V3 plugin system.
 * Uses unified platform.executionBackend for all execution.
 */

import type {
  PluginContextDescriptor,
  UIFacade,
  PlatformServices,
} from "@kb-labs/plugin-contracts";
import { wrapCliResult } from "@kb-labs/plugin-runtime";
import type { PlatformContainer } from "@kb-labs/core-runtime";
import type {
  ExecutionRequest,
  OnLogCallback,
} from "@kb-labs/plugin-execution-factory";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface ExecuteCommandV3Options {
  /**
   * Plugin ID (e.g., "@kb-labs/my-plugin")
   */
  pluginId: string;

  /**
   * Plugin version
   */
  pluginVersion: string;

  /**
   * Path to command handler file
   */
  handlerPath: string;

  /**
   * Absolute plugin root directory. When the caller already knows where
   * the plugin lives (e.g. from a discovery result's `pkgRoot`), it should
   * pass it here — module resolution inside the execution backend will
   * then search the plugin's own `node_modules`, which is required for
   * project-scope plugins whose dependencies live at
   * `<projectRoot>/.kb/plugins/<name>/node_modules/`.
   *
   * If omitted, a fallback resolver walks `node_modules` starting from
   * `cwd` (legacy behaviour — only works for plugins installed at the
   * CLI invocation directory).
   */
  pluginRoot?: string;

  /**
   * Command arguments
   */
  argv: string[];

  /**
   * Command flags
   */
  flags: Record<string, unknown>;

  /**
   * Plugin configuration
   */
  config?: unknown;

  /**
   * Plugin permissions
   */
  permissions?: PluginContextDescriptor["permissions"];

  /**
   * Working directory
   */
  cwd?: string;

  /**
   * Output directory
   */
  outdir?: string;

  /**
   * Tenant ID
   */
  tenantId?: string;

  /**
   * UI facade for user interaction
   */
  ui: UIFacade;

  /**
   * Platform services
   */
  platform: PlatformServices;

  /**
   * Platform container (for executionBackend access - internal use only)
   */
  platformContainer: PlatformContainer;

  /**
   * Abort signal
   */
  signal?: AbortSignal;

  /** Worker stdout/stderr callback, when the caller needs command output. */
  onLog?: OnLogCallback;

  /** Structured plugin logger callback, when the caller needs command output. */
  onLoggerLog?: OnLogCallback;

  /**
   * Development mode (runs in-process for easier debugging)
   */
  devMode?: boolean;

  /**
   * Unix socket path for IPC communication.
   * If not provided, will attempt to get from platform.getSocketPath()
   */
  socketPath?: string;

  /**
   * Resource quotas from manifest
   */
  quotas?: {
    timeoutMs?: number;
    memoryMb?: number;
    cpuMs?: number;
  };

  /**
   * Config section identifier from manifest (for useConfig auto-detection)
   */
  configSection?: string;

  /** Sanitized, non-secret LLM routing metadata for sandbox workers. */
  llmRouting?: PluginContextDescriptor["llmRouting"];
}

/**
 * Execute a plugin command via V3 plugin system
 *
 * @param options Execution options
 * @returns Exit code (0 for success, non-zero for failure)
 *
 * @example
 * ```typescript
 * const exitCode = await executeCommandV3({
 *   pluginId: '@kb-labs/my-plugin',
 *   pluginVersion: '1.0.0',
 *   handlerPath: '/path/to/handler.js',
 *   argv: ['arg1', 'arg2'],
 *   flags: { verbose: true },
 *   ui: cliUIFacade,
 *   platform: platformServices,
 * });
 * ```
 */
export async function executeCommandV3(
  options: ExecuteCommandV3Options,
): Promise<number> {
  const {
    pluginId,
    pluginVersion,
    handlerPath,
    argv,
    flags,
    config: _config,
    permissions = {},
    cwd: _cwd = process.cwd(),
    outdir: _outdir,
    tenantId,
    ui,
    platform: _platform,
    signal,
    onLog,
    onLoggerLog,
    devMode: _devMode = false,
    socketPath: _socketPath,
    quotas,
    configSection,
    llmRouting,
  } = options;

  // Create plugin context descriptor
  const requestId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const traceId = `trace-${randomUUID()}`;
  const spanId = `span-${randomUUID()}`;
  const invocationId = `inv-${randomUUID()}`;
  const executionId = `exec-${randomUUID()}`;

  const descriptor: PluginContextDescriptor = {
    hostType: "cli",
    pluginId,
    pluginVersion,
    tenantId,
    permissions,
    hostContext: { host: "cli", argv, flags },
    requestId,
    configSection,
    llmRouting,
  };
  Object.assign(descriptor as unknown as Record<string, unknown>, {
    traceId,
    spanId,
    invocationId,
    executionId,
  });

  // Prepare input
  const input = { argv, flags };

  try {
    // Resolve plugin root (required by ExecutionBackend). Prefer the
    // caller-supplied pkgRoot — the CLI discovery layer already knows
    // exactly where the plugin lives and this is the only path that
    // handles project-scope plugins whose deps live outside cwd.
    const pluginRoot =
      options.pluginRoot ?? resolvePluginRoot(pluginId, options.cwd ?? process.cwd());

    // Build ExecutionRequest for platform.executionBackend
    const request: ExecutionRequest = {
      executionId,
      descriptor,
      pluginRoot,
      handlerRef: handlerPath,
      input,
      timeoutMs: quotas?.timeoutMs,
      // Pass cwd so worker-pool backend sets ctx.cwd to the invocation directory,
      // not the platform installation directory (worker-script.ts reads workspace.cwd)
      workspace: { cwd: _cwd },
    };

    // Execute via unified platform.executionBackend
    // Backend respects platform.execution config (in-process, worker-pool, etc.)
    //
    // Use the platformContainer passed from v3-adapter (which got it from bootstrap)
    // This ensures we use the SAME instance that was initialized with ExecutionBackend
    const result =
      await options.platformContainer.executionBackend.execute(request, {
        signal,
        onLog,
        onLoggerLog,
      });

    // Handle execution result
    if (!result.ok) {
      ui.error(result.error?.message || "Execution failed");
      return 1;
    }

    // Wrap result for CLI (preserves backward compatibility)
    const executionMeta = result.metadata?.executionMeta ?? {
      startTime: Date.now(),
      endTime: Date.now(),
      duration: 0,
      pluginId,
      pluginVersion,
      requestId,
    };
    const runResult = {
      ok: true as const,
      data: result.data,
      executionMeta,
    };
    const cliResult = wrapCliResult(runResult, descriptor);

    // Return exit code from wrapped result
    return cliResult.exitCode;
  } catch (error) {
    // Handle execution errors
    ui.error(error instanceof Error ? error : String(error));
    return 1;
  }
}

/**
 * Fallback resolver for plugin root when the caller didn't supply one.
 *
 * Strategy: ask Node's resolver to find `<pluginId>/package.json` with a
 * search path rooted at `searchFrom`. This correctly handles hoisted
 * node_modules in pnpm workspaces and installed mode (the CLI wrapper
 * passes its cwd, which is the project root).
 *
 * This fallback is intentionally narrow — it can't find plugins whose
 * `node_modules` live outside the search path (e.g. a project-scope
 * plugin under `<projectRoot>/.kb/plugins/<name>/node_modules/` when the
 * CLI is invoked from elsewhere). For those callers must pass
 * `pluginRoot` explicitly.
 */
function resolvePluginRoot(pluginId: string, searchFrom: string): string {
  const nodeModulesPath = path.resolve(searchFrom, "node_modules", pluginId);
  try {
    const packageJson = require.resolve(`${pluginId}/package.json`, {
      paths: [searchFrom],
    });
    return path.dirname(packageJson);
  } catch {
    // Return the conventional path and let the execution backend surface
    // a clearer error (E_HANDLER_NOT_FOUND) than a generic resolve failure.
    return nodeModulesPath;
  }
}
