/**
 * Bootstrap script for sandboxed plugin execution
 *
 * This is the entry point for the child process.
 * It receives the descriptor via IPC and creates the context.
 */

import type { ParentMessage, ChildMessage, ExecuteMessage, LogMessage } from './ipc-protocol.js';
import type { UIFacade } from '@kb-labs/plugin-contracts';
import { PluginError, wrapError, noopUI } from '@kb-labs/plugin-contracts';
import { createBaseStdoutUI, NOOP_PROMPTS, setJsonMode } from '@kb-labs/shared-cli-ui';
import { createPluginContextV3 } from '../context/index.js';
import { executeCleanup, type EventEmitterFn } from '../api/index.js';
import { applySandboxPatches, type SandboxMode } from './harden.js';
import { setGlobalContext, clearGlobalContext } from './context-holder.js';

// ARCHITECTURE NOTE: Platform Initialization in Child Process
//
// Platform is NOT initialized in child process via initPlatform().
// Instead, child process connects to parent's platform via IPC proxy (connectToPlatform).
// This eliminates circular dependency: core-runtime ↔ plugin-execution-factory ↔ plugin-runtime
//
// Flow:
// 1. Parent process initializes platform (core-runtime/loader.ts)
// 2. Parent spawns child process (SubprocessBackend via runInSubprocess)
// 3. Child calls connectToPlatform() to get RPC proxy to parent's platform
// 4. Child uses platform services via IPC (Unix socket)
//
// Legacy code removed (2026-01-28):
// - Dynamic import of initPlatform() from core-runtime (caused circular dependency)
// - KB_RAW_CONFIG_JSON env var parsing (no longer needed)
// - platformReady Promise (no longer needed)
import { connectToPlatform } from './platform-client.js';


// Abort controller for cancellation
const abortController = new AbortController();

// Handle messages from parent
process.on('message', async (msg: ParentMessage) => {
  if (msg.type === 'abort') {
    abortController.abort();
    return;
  }

  if (msg.type !== 'execute') {return;}

  const executeMsg = msg as ExecuteMessage;
  const { descriptor, handlerPath, input, socketPath, cwd, outdir } = executeMsg;

  // Read sandbox mode from environment
  const sandboxMode = (process.env.KB_SANDBOX_MODE || 'enforce') as SandboxMode;

  // Apply sandbox patches BEFORE any plugin code runs
  // This prevents plugins from bypassing permissions via direct module imports
  const restoreSandbox = applySandboxPatches({
    permissions: descriptor.permissions,
    mode: sandboxMode, // Read from KB_SANDBOX_MODE env var
  });

  // Connect to platform services via RPC (Unix socket to parent process)
  const platform = await connectToPlatform(socketPath, descriptor.llmRouting);

  // Detect --json mode from flags (V3: always { flags, argv })
  const inputFlags = 'flags' in (input as object) ? (input as { flags: Record<string, unknown> }).flags : {};
  const jsonMode = Boolean(inputFlags.json);
  if (jsonMode) {setJsonMode(true);}

  // Create stdout UI (plain text output)
  let ui: UIFacade = createBaseStdoutUI(NOOP_PROMPTS, () => {});
  if (jsonMode) {
    ui = {
      ...noopUI,
      colors: ui.colors,
      symbols: ui.symbols,
      json: ui.json,
    };
  }

  // Create eventEmitter that sends log messages to parent via IPC
  const eventEmitter: EventEmitterFn = async (name, payload) => {
    if ((name === 'log.line' || name.endsWith(':log.line')) && payload && typeof payload === 'object') {
      const p = payload as Record<string, unknown>;
      const logMsg: LogMessage = {
        type: 'log',
        entry: {
          level: (p.level as string) ?? 'info',
          message: (p.line as string) ?? '',
          stream: (p.stream as 'stdout' | 'stderr') ?? 'stdout',
          lineNo: (p.lineNo as number) ?? 0,
          timestamp: new Date().toISOString(),
          meta: p.meta as Record<string, unknown> | undefined,
        },
      };
      process.send?.(logMsg);
    }
  };

  // Create context
  const { context, cleanupStack } = createPluginContextV3({
    descriptor,
    platform,
    ui,
    signal: abortController.signal,
    eventEmitter,
    cwd,
    outdir,
  });

  // Set global context for sandbox proxying (used in compat mode)
  setGlobalContext(context);

  // Set __KB_CONFIG_SECTION__ for useConfig() auto-detection (subprocess mode)
  if (descriptor.configSection) {
    const globalWithConfig = globalThis as typeof globalThis & { __KB_CONFIG_SECTION__?: string };
    globalWithConfig.__KB_CONFIG_SECTION__ = descriptor.configSection;
  }

  // Analytics scope injection for plugin execution
  // Save original source before overriding (for subprocess mode - not strictly needed since process dies)
  let originalSource: { product: string; version: string } | undefined;

  try {
    // Override analytics source with plugin-specific source
    // This ensures events tracked by the plugin show the correct source
    if (descriptor.pluginId && descriptor.pluginVersion && platform.analytics) {
      // Save original source (for consistency with in-process mode)
      originalSource = platform.analytics.getSource?.();

      // Override source to plugin source
      platform.analytics.setSource?.({
        product: descriptor.pluginId,
        version: descriptor.pluginVersion,
      });

      platform.logger?.debug?.('Analytics source overridden', {
        from: originalSource?.product,
        to: descriptor.pluginId,
      });
    }

    // Import handler
    const handlerModule = await import(handlerPath);
    const handler = handlerModule.default ?? handlerModule;

    if (typeof handler.execute !== 'function') {
      throw new PluginError(
        `Handler at ${handlerPath} does not export an execute function`,
        'INVALID_HANDLER'
      );
    }

    const handlerResult = await handler.execute(context, input);

    // Send raw handler result to parent — no host-specific wrapping.
    // Host layer (CLI, REST, Workflow) is responsible for interpreting the data.
    const resultMsg: ChildMessage = {
      type: 'result',
      data: handlerResult,
    };
    process.send?.(resultMsg);
  } catch (error) {
    // Send error to parent
    const pluginError = wrapError(error);
    const errorMsg: ChildMessage = {
      type: 'error',
      error: pluginError.toJSON(),
    };
    process.send?.(errorMsg);
  } finally {
    // Clear global context (prevent memory leaks)
    clearGlobalContext();

    // Execute cleanups
    await executeCleanup(cleanupStack, platform.logger);

    // Restore original globals (cleanup sandbox patches)
    restoreSandbox();
  }
});

// Signal ready to parent
const readyMsg: ChildMessage = { type: 'ready' };
process.send?.(readyMsg);
