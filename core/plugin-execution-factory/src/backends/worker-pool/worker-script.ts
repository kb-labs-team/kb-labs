/**
 * @module @kb-labs/plugin-execution/backends/worker-pool/worker-script
 *
 * Worker subprocess entry point.
 * This script runs in a forked process and handles IPC messages.
 *
 * stdio: ['pipe', 'inherit', 'inherit', 'ipc'] — stdout/stderr are inherited from
 * the parent process, so any console.log / process.stdout.write goes directly to
 * the terminal. UI output does NOT need IPC proxying.
 */

import type {
  WorkerMessage,
  ExecuteMessage,
  MiddlewaresInitMessage,
  ResultMessage,
  ErrorMessage,
  LogWorkerMessage,
  HealthOkMessage,
  ReadyMessage,
  ShutdownMessage,
  UIPromptMessage,
  UIPromptResultMessage,
} from './types.js';
import { SerializedErrorEnvelopeError } from '@kb-labs/core-platform';
import type { ExecutionError } from '@kb-labs/core-platform';
import { normalizeExecutionFailure } from '../../utils.js';
import type { PlatformServices, UIFacade, SelectChoice, MultiSelectChoice } from '@kb-labs/plugin-contracts';
import { IPCTransport, UnixSocketTransport, createProxyPlatform } from '@kb-labs/core-ipc';
import type { ITransport } from '@kb-labs/core-ipc';
import type { LoadedMiddleware } from '@kb-labs/plugin-runtime';
import { createBaseStdoutUI, setJsonMode, type UIPrompts } from '@kb-labs/shared-cli-ui';
import { InteractiveInputRequiredError } from '@kb-labs/shared-cli-ui/interactive';

// Worker state
const workerId = process.env.KB_WORKER_ID ?? 'unknown';

// Pending IPC prompt resolvers keyed by promptId
const pendingPrompts = new Map<string, (result: UIPromptResultMessage) => void>();
let promptCounter = 0;

/**
 * Send a UI prompt request to the host via IPC and await the result.
 * Rejects with an actionable error if the prompt cannot reach a responder.
 */
async function ipcPrompt(
  requestId: string,
  prompt: Omit<UIPromptMessage, 'type' | 'promptId' | 'requestId'>,
  timeoutMs = 60_000,
): Promise<unknown> {
  if (!process.send) {
    throw unavailablePrompt(prompt.message, 'The worker cannot relay this prompt to its host.');
  }

  const promptId = `prompt-${workerId}-${++promptCounter}`;
  const msg: UIPromptMessage = { type: 'uiPrompt', promptId, requestId, ...prompt };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPrompts.delete(promptId);
      reject(unavailablePrompt(prompt.message, 'The host did not answer the prompt.'));
    }, timeoutMs);

    pendingPrompts.set(promptId, (result) => {
      clearTimeout(timer);
      if (result.failure) {
        const { error: serializedError, ...envelope } = result.failure;
        reject(new SerializedErrorEnvelopeError(envelope, serializedError));
        return;
      }
      resolve(result.value);
    });

    process.send!(msg, (error) => {
      if (!error) return;
      pendingPrompts.delete(promptId);
      clearTimeout(timer);
      reject(unavailablePrompt(prompt.message, 'The worker could not send the prompt to its host.'));
    });
  });
}

const promptHint = 'Supply the requested value as command or request input and retry.';

function unavailablePrompt(message: string, reason: string): InteractiveInputRequiredError {
  return new InteractiveInputRequiredError(promptHint, `The prompt "${message}" cannot be answered. ${reason}`);
}
let isShuttingDown = false;

/**
 * Create platform transport based on KB_PLATFORM_TRANSPORT env var.
 * Parent process sets this env via PlatformTransportFactory.type.
 *
 * Built-in types:
 * - 'ipc' (default): IPCTransport via process.send/on('message')
 * - 'unix-socket': UnixSocketTransport via KB_PLATFORM_SOCKET_PATH
 *
 * Extensible: new transport types can be added here or via dynamic import
 * of a module specified in KB_PLATFORM_TRANSPORT_MODULE env var.
 */
function createTransport(): ITransport {
  const type = process.env.KB_PLATFORM_TRANSPORT ?? 'ipc';

  switch (type) {
    case 'ipc':
      return new IPCTransport();
    case 'unix-socket': {
      const socketPath = process.env.KB_PLATFORM_SOCKET_PATH;
      if (!socketPath) {
        throw new Error('unix-socket transport requires KB_PLATFORM_SOCKET_PATH env var');
      }
      return new UnixSocketTransport({ socketPath });
    }
    default:
      throw new Error(`Unknown platform transport type: '${type}'. Set KB_PLATFORM_TRANSPORT to 'ipc' or 'unix-socket'.`);
  }
}

// Platform proxy — created once at startup, shared across all executions.
// Transport type determined by KB_PLATFORM_TRANSPORT env var (set by parent).
const transport = createTransport();
const rawProxyPlatform = createProxyPlatform({ transport });

// Adapter middlewares — resolved once when 'middlewares' message arrives from pool.
// handleExecute awaits this promise so governance always runs with full middleware chain.
let middlewaresPromise: Promise<LoadedMiddleware[]> | null = null;


/**
 * Create a stdout UI with IPC proxy for interactive prompts.
 * stdout is inherited from parent so display output goes directly to terminal.
 * Interactive methods (select/multiSelect/confirm/prompt) are forwarded to the
 * host process via IPC and the result is awaited.
 */
function createStdoutUI(currentRequestId?: string): UIFacade {
  const prompts: UIPrompts = {
    confirm: async (msg, opts) => {
      const dv = opts?.defaultValue ?? false;
      if (!currentRequestId) { throw unavailablePrompt(msg, 'No execution request is active.'); }
      return ipcPrompt(currentRequestId, { kind: 'confirm', message: msg, defaultValue: dv }) as Promise<boolean>;
    },
    prompt: async (msg, opts) => {
      const dv = opts?.default ?? '';
      if (!currentRequestId) { throw unavailablePrompt(msg, 'No execution request is active.'); }
      return ipcPrompt(currentRequestId, { kind: 'text', message: msg, defaultValue: dv }) as Promise<string>;
    },
    select: async <T>(msg: string, choices: SelectChoice<T>[]) => {
      const dv = choices[0]?.value;
      if (!currentRequestId) { throw unavailablePrompt(msg, 'No execution request is active.'); }
      return ipcPrompt(currentRequestId, { kind: 'select', message: msg, choices, defaultValue: dv }) as Promise<T>;
    },
    multiSelect: async <T>(msg: string, choices: MultiSelectChoice<T>[]) => {
      const dv = choices.filter(c => c.checked).map(c => c.value);
      if (!currentRequestId) { throw unavailablePrompt(msg, 'No execution request is active.'); }
      return ipcPrompt(currentRequestId, { kind: 'multiSelect', message: msg, choices, defaultValue: dv }) as Promise<T[]>;
    },
  };
  return createBaseStdoutUI(prompts, (entry) => {
    const msg = entry.fields ? `${entry.message} ${JSON.stringify(entry.fields)}` : entry.message;
    console.log(`[${entry.level.toUpperCase()}] ${msg}`);
  });
}

/**
 * Handle execute message.
 */
async function handleExecute(message: ExecuteMessage): Promise<void> {
  const { requestId, request, timeoutMs: _timeoutMs } = message;
  const startMs = Date.now();
  try {
    // Dynamic import to avoid loading at startup
    const { runInProcess, createStreamingUI } = await import('@kb-labs/plugin-runtime');
    const path = await import('node:path');
    const fs = await import('node:fs');

    // Wait for adapter middlewares to be resolved (sent by pool right after 'ready').
    // IPC ordering guarantees 'middlewares' arrives before 'execute', but resolution
    // is async (dynamic imports), so we must await the promise.
    const adapterMiddlewares = middlewaresPromise ? await middlewaresPromise : [];

    // Resolve handler path — strip export name (#default, #namedExport) before fs check
    const [handlerRef = request.handlerRef] = request.handlerRef.split('#');
    let handlerPath = path.resolve(request.pluginRoot, handlerRef);

    // Fallback: try dist/<handlerRef> if the direct path doesn't exist (plugin built into dist/)
    if (!fs.existsSync(handlerPath)) {
      const distPath = path.resolve(request.pluginRoot, 'dist', handlerRef.replace(/^\.\//, ''));
      if (fs.existsSync(distPath)) {
        handlerPath = distPath;
      }
    }

    if (!fs.existsSync(handlerPath)) {
      sendError(requestId, normalizeExecutionFailure(new Error(`Handler not found: ${handlerPath}`), request).error);
      return;
    }

    // Pre-initialize EmbeddingsProxy dimensions via IPC (cached after first call).
    // Required before any handler accesses platform.embeddings.dimensions synchronously.
    const embProxy = rawProxyPlatform.embeddings as unknown as { getDimensions?: () => Promise<number> };
    if (typeof embProxy.getDimensions === 'function') {
      await embProxy.getDimensions().catch(() => {});
    }

    // Platform proxy: rawProxyPlatform forwards adapter calls to parent via IPC.
    // Governance (permissions + adapter middlewares) is applied inside runInProcess()
    // via applyPluginGovernance — do NOT pre-govern here to avoid double-wrapping.
    const platform = rawProxyPlatform as PlatformServices;

    // cwd = workspace root, not plugin dir
    const cwd = request.workspace?.cwd ?? process.cwd();

    // Detect --json mode
    const rawInput = request.input;
    const inputAsObj = (typeof rawInput === 'object' && rawInput !== null) ? rawInput as Record<string, unknown> : {};
    const inputFlagsRaw = inputAsObj['flags'];
    const inputFlags: Record<string, unknown> = (typeof inputFlagsRaw === 'object' && inputFlagsRaw !== null)
      ? inputFlagsRaw as Record<string, unknown>
      : {};
    const jsonMode = Boolean(inputFlags['json']);
    if (jsonMode) { setJsonMode(true); }

    // Capture original write before any interception (used by debug + makeCapture).
    type WriteFn = (chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => boolean;
    const origStdoutWrite = process.stdout.write.bind(process.stdout) as WriteFn;
    const origStderrWrite = process.stderr.write.bind(process.stderr) as WriteFn;

    // eventEmitter sends log lines to parent pool via IPC.
    // Routes by event name — 'log.line' (ui/shell) vs 'logger.line' (ctx.logger.*).
    // See: services/workflow/docs/adr/0019-log-stream-separation.md
    const eventEmitter = async (name: string, payload?: unknown) => {
      const isLogLine = name === 'log.line' || name.endsWith(':log.line');
      const isLoggerLine = name === 'logger.line' || name.endsWith(':logger.line');
      if ((isLogLine || isLoggerLine) && payload && typeof payload === 'object') {
        const p = payload as Record<string, unknown>;
        const entry = {
          level: (p.level as string) ?? 'info',
          message: (p.line as string) ?? '',
          stream: (p.stream as 'stdout' | 'stderr') ?? 'stdout',
          lineNo: (p.lineNo as number) ?? 0,
          timestamp: new Date().toISOString(),
          meta: p.meta as Record<string, unknown> | undefined,
        };
        process.send!({ type: isLoggerLine ? 'loggerLog' : 'log', requestId, entry });
      }
    };

    // UI: wrap with StreamingUI so ui.info/warn/error/write also reach the log stream.
    // In json mode keep a minimal UI but still stream through eventEmitter.
    const stdoutUI = createStdoutUI(requestId);
    const baseUI: UIFacade = jsonMode ? { ...stdoutUI, json: stdoutUI.json } : stdoutUI;
    const ui: UIFacade = createStreamingUI(baseUI, eventEmitter);

    // Intercept raw stdout/stderr to capture console.log() and third-party output.
    // Safe here: this is an isolated child process handling exactly one request at a time.
    const ANSI_RE = /\x1b\[[0-9;]*m/g;
    let rawLineNo = 0;
    const sendRawLine = (text: string, stream: 'stdout' | 'stderr') => {
      const clean = text.replace(ANSI_RE, '');
      for (const line of clean.split('\n')) {
        if (!line.trim()) { continue; }
        rawLineNo++;
        process.send!({
          type: 'log', requestId,
          // stderr is not equivalent to a failed execution. Discovery and
          // other CLI tooling intentionally emit diagnostics on stderr while
          // exiting successfully; the result/exit code remains authoritative.
          entry: { level: stream === 'stderr' ? 'warn' : 'info', message: line, stream, lineNo: rawLineNo, timestamp: new Date().toISOString() },
        } satisfies LogWorkerMessage);
      }
    };

    const makeCapture = (orig: WriteFn, stream: 'stdout' | 'stderr'): WriteFn =>
      (chunk, encoding?, cb?) => {
        sendRawLine(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'), stream);
        return orig(chunk, encoding as BufferEncoding, cb);
      };
    process.stdout.write = makeCapture(origStdoutWrite, 'stdout') as typeof process.stdout.write;
    process.stderr.write = makeCapture(origStderrWrite, 'stderr') as typeof process.stderr.write;

    let result!: Awaited<ReturnType<typeof runInProcess>>;
    try {
      result = await runInProcess({
        descriptor: request.descriptor,
        platform,
        ui,
        eventEmitter,
        handlerPath,
        cwd,
        input: request.input,
        environment: request.env,
        adapterMiddlewares,
      });
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    }

    const elapsedMs = Date.now() - startMs;

    const resultMessage: ResultMessage = {
      type: 'result',
      requestId,
      result: {
        ok: true,
        data: result.data,
        executionTimeMs: elapsedMs,
        metadata: {
          backend: 'worker-pool',
          workerId,
          executionMeta: result.executionMeta,
        },
      },
    };

    process.send!(resultMessage);
  } catch (error) {
    sendError(requestId, normalizeExecutionFailure(error, request).error);
  }
}

/**
 * Handle middlewares init message from pool.
 * Kicks off async resolution of adapter middleware handlers and caches the result.
 */
function handleMiddlewares(message: MiddlewaresInitMessage): void {
  middlewaresPromise = import('@kb-labs/plugin-runtime').then(({ resolveAdapterMiddlewares }) =>
    resolveAdapterMiddlewares(message.decls)
  );
}

/**
 * Send error message to parent.
 */
function sendError(requestId: string, error: ExecutionError): void {
  process.send!({ type: 'error', requestId, error } as ErrorMessage);
}

function handleHealth(): void {
  const memory = process.memoryUsage();
  process.send!({
    type: 'healthOk',
    memoryUsage: { heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, rss: memory.rss },
    uptime: process.uptime(),
  } as HealthOkMessage);
}

function handleShutdown(message: ShutdownMessage): void {
  isShuttingDown = true;
  transport.close().catch(() => {});
  if (message.graceful) {
    setTimeout(() => process.exit(0), 100);
  } else {
    process.exit(0);
  }
}

function onMessage(message: WorkerMessage): void {
  if (isShuttingDown && message.type !== 'shutdown') { return; }
  switch (message.type) {
    case 'execute': handleExecute(message as ExecuteMessage); break;
    case 'middlewares': handleMiddlewares(message as MiddlewaresInitMessage); break;
    case 'health': handleHealth(); break;
    case 'shutdown': handleShutdown(message as ShutdownMessage); break;
    case 'uiPromptResult': {
      const result = message as UIPromptResultMessage;
      const resolve = pendingPrompts.get(result.promptId);
      if (resolve) {
        pendingPrompts.delete(result.promptId);
        resolve(result);
      }
      break;
    }
  }
}

process.on('message', onMessage);

process.on('uncaughtException', (error) => {
  console.error(`[Worker ${workerId}] Uncaught exception:`, error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[Worker ${workerId}] Unhandled rejection:`, reason);
  process.exit(1);
});

process.send!({ type: 'ready', pid: process.pid } as ReadyMessage);
