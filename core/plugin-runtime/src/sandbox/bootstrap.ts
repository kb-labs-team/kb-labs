/** Child entry point for subprocess and container executions. */

import { Writable } from 'node:stream';
import { createStdioChannel, encodeStdioFrame } from '@kb-labs/core-ipc';
import type { StdioFrame } from '@kb-labs/core-ipc';
import type { UIFacade } from '@kb-labs/plugin-contracts';
import type { PlatformServices } from '@kb-labs/plugin-contracts';
import { PluginError } from '@kb-labs/plugin-contracts';
import { serializeError, toErrorEnvelope } from '@kb-labs/core-platform';
import { createBaseStdoutUI, NOOP_PROMPTS, setJsonMode } from '@kb-labs/shared-cli-ui';
import { createPluginContextV3 } from '../context/index.js';
import { rehydrateWSInput } from '../ws/sender.js';
import type { WSInputReference } from '@kb-labs/plugin-contracts';
import { executeCleanup, type EventEmitterFn } from '../api/index.js';
import type { CleanupFn } from '@kb-labs/plugin-contracts';
import { applySandboxPatches, type SandboxMode } from './harden.js';
import { setGlobalContext, clearGlobalContext } from './context-holder.js';
import { connectToPlatform, disconnectFromPlatform } from './platform-client.js';
import type { ExecuteMessage } from './ipc-protocol.js';
import { installPlatformResolveHook } from '../platform-resolve/index.js';

const rawStdout = process.stdout;
const writeRawStdout = rawStdout.write.bind(rawStdout);
const frameWriter = new Writable({
  write(chunk, _encoding, callback) {
    writeRawStdout(chunk, callback);
  },
});
const channel = createStdioChannel(process.stdin, frameWriter);
const abortController = new AbortController();
let started = false;

function capturePluginStdout(): void {
  const capturedWrite: typeof process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8';
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    const message = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding);
    const frame: StdioFrame = { type: 'log', level: 'info', message, stream: 'stdout' };
    void channel.send(frame).then(() => done?.()).catch((error: unknown) => {
      const diagnostic = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Plugin stdout could not be framed: ${diagnostic}\n`);
      process.exitCode = 1;
    });
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = capturedWrite;
}

capturePluginStdout();
channel.onError((error) => {
  process.stderr.write(`Invalid child control stream: ${error.message}\n`);
  process.exitCode = 1;
  abortController.abort();
});
process.stdin.on('end', () => {
  abortController.abort();
  process.exit();
});

channel.on('execution:cancel', () => abortController.abort());

channel.on('execution:start', (frame) => {
  if (started) {
    process.exitCode = 1;
    process.stderr.write('Received more than one execution start frame.\n');
    return;
  }
  started = true;
  void execute(frame.requestId, frame.payload as ExecuteMessage);
});

void channel.send({ type: 'runtime:ready' }).catch((error: unknown) => {
  const diagnostic = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Runtime readiness frame could not be written: ${diagnostic}\n`);
  process.exitCode = 1;
});

async function execute(requestId: string, message: ExecuteMessage): Promise<void> {
  let platform: PlatformServices | undefined;
  let restoreSandbox: (() => void) | undefined;
  let cleanupStack: CleanupFn[] = [];
  let result: unknown;
  let failure: unknown;
  try {
    if (message.requestId !== requestId) {
      throw new Error('Execution start frame request id does not match its payload');
    }
    const { descriptor, handlerPath, input, cwd, outdir, strictFilesystemPermissions } = message;
    platform = await connectToPlatform(channel);
    const sandboxMode = (process.env.KB_SANDBOX_MODE || 'enforce') as SandboxMode;
    restoreSandbox = applySandboxPatches({ permissions: descriptor.permissions, mode: sandboxMode });
    const inputFlags = 'flags' in (input as object) ? (input as { flags: Record<string, unknown> }).flags : {};
    if (Boolean(inputFlags.json)) { setJsonMode(true); }
    const ui: UIFacade = createBaseStdoutUI(NOOP_PROMPTS, () => {});
    const eventEmitter: EventEmitterFn = async (name, payload) => {
      if ((name === 'log.line' || name.endsWith(':log.line'))
        && typeof payload === 'object' && payload !== null) {
        const value = payload as Record<string, unknown>;
        await channel.send({
          type: 'log',
          level: typeof value.level === 'string' ? value.level : 'info',
          message: typeof value.line === 'string' ? value.line : '',
          stream: value.stream === 'stderr' ? 'stderr' : 'stdout',
          meta: typeof value.meta === 'object' && value.meta !== null ? value.meta as Record<string, unknown> : undefined,
        });
      }
    };
    const contextResult = createPluginContextV3({
      descriptor,
      platform,
      ui,
      signal: abortController.signal,
      eventEmitter,
      cwd,
      outdir,
      strictFilesystemPermissions,
    });
    cleanupStack = contextResult.cleanupStack;
    setGlobalContext(contextResult.context);
    if (descriptor.configSection) {
      const globalWithConfig = globalThis as typeof globalThis & { __KB_CONFIG_SECTION__?: string };
      globalWithConfig.__KB_CONFIG_SECTION__ = descriptor.configSection;
    }
    if (descriptor.pluginId && descriptor.pluginVersion && platform.analytics) {
      platform.analytics.setSource?.({ product: descriptor.pluginId, version: descriptor.pluginVersion });
    }
    const platformRoot = process.env.KB_PLATFORM_ROOT;
    if (platformRoot) {
      installPlatformResolveHook({ platformRoot, anchors: [import.meta.url] });
    }
    const handlerModule = await import(handlerPath);
    const handler = handlerModule.default ?? handlerModule;
    if (typeof handler.execute !== 'function') {
      throw new PluginError(`Handler at ${handlerPath} does not export an execute function`, 'KB_PLUGIN_LOAD_FAILED', { plugin: descriptor.pluginId });
    }
    const handlerInput = descriptor.hostType === 'ws'
      ? rehydrateWSInput(input as WSInputReference, platform.websocket)
      : input;
    result = await handler.execute(contextResult.context, handlerInput);
  } catch (error) {
    failure = error;
  } finally {
    clearGlobalContext();
    const cleanupErrors: unknown[] = [];
    if (platform) {
      try { await executeCleanup(cleanupStack, platform.logger); } catch (error) { cleanupErrors.push(error); }
    }
    try { restoreSandbox?.(); } catch (error) { cleanupErrors.push(error); }
    try { await disconnectFromPlatform(); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 0) {
      failure = failure === undefined
        ? new AggregateError(cleanupErrors, 'Plugin execution cleanup failed')
        : new AggregateError([failure, ...cleanupErrors], 'Plugin execution and cleanup failed');
    }
  }
  if (failure !== undefined) {
    await channel.send({
      type: 'execution:error',
      requestId,
      payload: { envelope: toErrorEnvelope(failure), serializedError: serializeError(failure) },
    });
    return;
  }
  await channel.send({ type: 'execution:result', requestId, payload: result });
}
