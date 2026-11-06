/**
 * Sandbox runner for executing plugins
 *
 * Supports two modes:
 * - In-process: For trusted plugins or development
 * - Subprocess: For sandboxed execution
 *
 * Runner layer is host-agnostic - it returns RunResult<T> with raw data.
 * Host layer (CLI, REST, etc.) wraps this into host-specific format.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { SerializedErrorEnvelopeError } from '@kb-labs/core-platform';
import type { ErrorEnvelope, SerializedError } from '@kb-labs/core-platform';
import type { IPlatformAdapters } from '@kb-labs/core-platform';
import { createStdioChannel, StdioPlatformServer } from '@kb-labs/core-ipc';
import {
  platformContext,
  runtimeContext,
} from '@kb-labs/plugin-contracts';
import type {
  PluginContextDescriptor,
  PlatformServices,
  UIFacade,
  RunResult,
  ExecutionMeta,
} from '@kb-labs/plugin-contracts';
import { PluginError, TimeoutError, AbortError, createExecutionMeta } from '@kb-labs/plugin-contracts';
import type { ExecuteMessage } from './ipc-protocol.js';
import { createPluginContextV3 } from '../context/index.js';
import { rehydrateWSInput } from '../ws/sender.js';
import type { WSInputReference } from '@kb-labs/plugin-contracts';
import { executeCleanup, type PluginInvokerFn, type EventEmitterFn } from '../api/index.js';
import type { LoadedMiddleware } from '../platform/pipeline.js';
import { installPlatformResolveHook } from '../platform-resolve/index.js';

/**
 * Create execution metadata from descriptor and timing
 */
function buildExecutionMeta(
  descriptor: PluginContextDescriptor,
  startTime: number
): ExecutionMeta {
  return createExecutionMeta({
    pluginId: descriptor.pluginId,
    pluginVersion: descriptor.pluginVersion,
    handlerId: descriptor.handlerId,
    requestId: descriptor.requestId,
    tenantId: descriptor.tenantId,
    startTime,
  });
}

export interface RunInProcessOptions {
  descriptor: PluginContextDescriptor;
  platform: PlatformServices;
  ui: UIFacade;
  pluginInvoker?: PluginInvokerFn;
  eventEmitter?: EventEmitterFn;
  handlerPath: string;
  input: unknown;
  signal?: AbortSignal;
  cwd: string;
  outdir?: string;
  environment?: Record<string, string | undefined>;
  /** Resolved adapter middlewares to apply before governance. */
  adapterMiddlewares?: LoadedMiddleware[];
}

export interface RunInSubprocessOptions {
  descriptor: PluginContextDescriptor;
  platform: IPlatformAdapters;
  handlerPath: string;
  input: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd: string;
  outdir?: string;
  environment?: Record<string, string | undefined>;
  onLog?: (entry: { level: string; message: string; stream: 'stdout' | 'stderr'; lineNo: number; timestamp: string; meta?: Record<string, unknown> }) => void;
}

/**
 * Run plugin handler in the current process (no sandbox)
 *
 * Returns raw handler result wrapped in RunResult with execution metadata.
 * Host layer is responsible for transforming this into host-specific format.
 *
 * @returns RunResult<T> with raw data from handler and execution metadata
 */
export async function runInProcess<T = unknown>(
  options: RunInProcessOptions
): Promise<RunResult<T>> {
  const { descriptor, platform, ui, pluginInvoker, eventEmitter, handlerPath, input, signal, cwd, outdir, environment, adapterMiddlewares } = options;
  const startTime = Date.now();

  // Create context
  const { context, cleanupStack } = createPluginContextV3({
    descriptor,
    platform,
    ui,
    signal,
    pluginInvoker,
    eventEmitter,
    cwd,
    outdir,
    environment,
    adapterMiddlewares,
  });

  // Set __KB_CONFIG_SECTION__ for useConfig() auto-detection (in-process mode)
  if (descriptor.configSection) {
    const globalWithConfig = globalThis as typeof globalThis & { __KB_CONFIG_SECTION__?: string };
    globalWithConfig.__KB_CONFIG_SECTION__ = descriptor.configSection;
  }

  // Analytics scope injection for plugin execution
  // Save original source before overriding (for in-process mode)
  let originalSource: { product: string; version: string } | undefined;

  try {
    // Override analytics source with plugin-specific source
    // This ensures events tracked by the plugin show the correct source
    if (descriptor.pluginId && descriptor.pluginVersion && platform.analytics) {
      // Save original source for restore (in-process mode)
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

    // Plugin code can be outside the installed platform tree (for example, a
    // Marketplace store entry). Resolve its platform packages from the one
    // platform copy in this process before importing the handler.
    const platformRoot = process.env.KB_PLATFORM_ROOT;
    if (platformRoot) {
      installPlatformResolveHook({ platformRoot, anchors: [import.meta.url] });
    }

    // Import and execute handler
    const [modulePath = handlerPath, exportName] = handlerPath.split('#', 2);
    const handlerModule = await import(modulePath);
    const handler = exportName ? handlerModule[exportName] : handlerModule.default ?? handlerModule;

    if (typeof handler.execute !== 'function') {
      throw new PluginError(
        `Handler at ${handlerPath} does not export an execute function`,
        'KB_PLUGIN_LOAD_FAILED',
        { plugin: descriptor.pluginId },
      );
    }

    // Execute handler within platform + runtime contexts (AsyncLocalStorage).
    // platformContext → usePlatform()/useLLM()/etc. return governed platform
    // runtimeContext → useEnv()/useFS()/useFetch() return sandboxed shims
    const handlerInput = descriptor.hostType === 'ws'
      ? rehydrateWSInput(input as WSInputReference, platform.websocket)
      : input;
    const data = await platformContext.run(context.platform, () =>
      runtimeContext.run(context.runtime, () =>
        handler.execute(context, handlerInput)
      )
    ) as T;

    // Return raw result with execution metadata
    return {
      ok: true,
      data,
      executionMeta: buildExecutionMeta(descriptor, startTime),
    };
  } finally {
    // Restore original analytics source (for in-process mode)
    // In subprocess mode, this is not needed (process dies after handler)
    // But for in-process mode, we must restore to avoid cross-plugin contamination
    if (originalSource && platform.analytics?.setSource) {
      platform.analytics.setSource(originalSource);
      platform.logger?.debug?.('Analytics source restored', {
        to: originalSource.product,
      });
    }

    // Execute cleanups
    await executeCleanup(cleanupStack, platform.logger);
  }
}

/**
 * Run plugin handler in a subprocess (sandboxed)
 *
 * Returns raw handler result wrapped in RunResult with execution metadata.
 * Host layer is responsible for transforming this into host-specific format.
 *
 * @returns RunResult<T> with raw data from handler and execution metadata
 */
export async function runInSubprocess<T = unknown>(
  options: RunInSubprocessOptions
): Promise<RunResult<T>> {
  const {
    descriptor,
    platform,
    handlerPath,
    input,
    timeoutMs = 30000,
    signal,
  } = options;

  if (signal?.aborted) { throw new AbortError(); }

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    // Path to bootstrap script
    // Strategy: try multiple locations to find bootstrap.js
    // 1. Same dir as current module (production: cli-bin/dist/bootstrap.js)
    // 2. Sandbox subdir (development: runtime-v3/dist/sandbox/bootstrap.js)
    // 3. Relative to cwd (fallback)

    const BOOTSTRAP = 'bootstrap.js';
    const currentDir = path.dirname(new URL(import.meta.url).pathname);
    const possiblePaths = [
      path.join(currentDir, BOOTSTRAP),                    // Production (same dir)
      path.join(currentDir, 'sandbox', BOOTSTRAP),         // Nested sandbox dir
      path.join(process.cwd(), 'dist', 'sandbox', BOOTSTRAP), // Test/dev mode
      path.join(process.cwd(), 'dist', BOOTSTRAP),         // Fallback
      path.join(process.cwd(), 'packages', 'plugin-runtime', 'dist', 'sandbox', BOOTSTRAP), // Monorepo test mode
    ];

    let bootstrapPath: string | undefined;
    for (const p of possiblePaths) {
      try {
        fs.accessSync(p, fs.constants.R_OK);
        bootstrapPath = p;
        break;
      } catch {
        continue;
      }
    }

    if (!bootstrapPath) {
      throw new Error(
        `[V3] Could not find bootstrap.js. Tried:\n${possiblePaths.join('\n')}`
      );
    }

    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [bootstrapPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...options.environment,
        NODE_ENV: process.env.NODE_ENV,
      },
    });

    let completed = false;
    let stderrBuffer = '';
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let cancelId: ReturnType<typeof setTimeout> | undefined;
    const channel = createStdioChannel(child.stdout, child.stdin);
    const platformServer = new StdioPlatformServer(channel, platform);
    const finish = () => {
      completed = true;
      clearTimeout(timeoutId);
      clearTimeout(cancelId);
      signal?.removeEventListener('abort', abortHandler);
      platformServer.close();
      channel.close();
      child.stdin.end();
    };
    const fail = (error: Error) => {
      if (completed) { return; }
      finish();
      child.kill('SIGKILL');
      reject(error);
    };

    // Handle abort signal
    const abortHandler = () => {
      if (!completed) {
        void channel.send({ type: 'execution:cancel', requestId: descriptor.requestId ?? '' })
          .finally(() => child.stdin.end());
        cancelId = setTimeout(() => fail(new AbortError()), 1000);
      }
    };

    if (signal) {
      signal.addEventListener('abort', abortHandler);
    }

    channel.onError((error) => fail(error));

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8');
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        options.onLog?.({
          level: 'error', message: line, stream: 'stderr', lineNo: 0, timestamp: new Date().toISOString(),
        });
      }
    });
    child.stderr.on('end', () => {
      if (stderrBuffer.length > 0) {
        options.onLog?.({
          level: 'error', message: stderrBuffer, stream: 'stderr', lineNo: 0, timestamp: new Date().toISOString(),
        });
      }
    });

    // Set timeout
    // eslint-disable-next-line prefer-const
    timeoutId = setTimeout(() => {
      if (!completed) {
        fail(new TimeoutError(`Plugin execution timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const requestId = descriptor.requestId ?? '';
    const executeMsg: ExecuteMessage = {
      requestId,
      descriptor,
      handlerPath,
      input,
      cwd: options.cwd,
      strictFilesystemPermissions: false,
      outdir: options.outdir,
    };
    void channel.send({ type: 'execution:start', requestId, payload: executeMsg }).catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    channel.on('log', (frame) => {
      options.onLog?.({
        level: frame.level,
        message: frame.message,
        stream: frame.stream,
        lineNo: 0,
        timestamp: new Date().toISOString(),
        meta: frame.meta,
      });
    });
    channel.on('execution:result', (frame) => {
      if (frame.requestId !== requestId) { fail(new Error('Execution result request id does not match')); return; }
      finish();
      resolve({
        ok: true,
        data: (frame.payloadUndefined ? undefined : frame.payload) as T,
        executionMeta: buildExecutionMeta(descriptor, startTime),
      });
    });
    channel.on('execution:error', (frame) => {
      if (frame.requestId !== requestId) { fail(new Error('Execution error request id does not match')); return; }
      const payload = frame.payload;
      if (typeof payload !== 'object' || payload === null || !('envelope' in payload)) {
        fail(new Error('Execution error frame did not contain an error envelope'));
        return;
      }
      if (!('serializedError' in payload) || typeof payload.serializedError !== 'object' || payload.serializedError === null
        || !('name' in payload.serializedError) || typeof payload.serializedError.name !== 'string'
        || !('message' in payload.serializedError) || typeof payload.serializedError.message !== 'string') {
        fail(new Error('Execution error frame did not contain a serialized error'));
        return;
      }
      const errorPayload = payload as { envelope: ErrorEnvelope; serializedError: SerializedError };
      finish();
      reject(new SerializedErrorEnvelopeError(errorPayload.envelope, errorPayload.serializedError));
    });

    // Handle child exit
    child.on('exit', (code) => {
      if (!completed) {
        finish();

        if (signal?.aborted) {
          reject(new AbortError());
        } else {
          reject(new PluginError(
            `Plugin process exited with code ${code}`,
            'KB_PLUGIN_CRASHED',
            { plugin: descriptor.pluginId }
          ));
        }
      }
    });

    // Handle child error
    child.on('error', (error) => {
      if (!completed) {
        fail(error);
      }
    });
  });
}
