import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';
import { createWorkerOutputCapture, type WorkerOutputCapture } from './worker-pool/output-capture.js';

interface RequestCapture {
  stdout: WorkerOutputCapture;
  stderr: WorkerOutputCapture;
}

const requestCapture = new AsyncLocalStorage<RequestCapture>();
let installed = false;

function installRequestScopedStdoutCapture(): void {
  if (installed) { return; }
  installed = true;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const capture = requestCapture.getStore()?.stdout;
    return capture ? capture(chunk, encodingOrCallback, callback) : originalStdoutWrite(chunk as never, encodingOrCallback as never, callback as never);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const capture = requestCapture.getStore()?.stderr;
    return capture ? capture(chunk, encodingOrCallback, callback) : originalStderrWrite(chunk as never, encodingOrCallback as never, callback as never);
  }) as typeof process.stderr.write;
  const wrapConsole = (method: 'log' | 'info' | 'debug' | 'warn' | 'error', stream: 'stdout' | 'stderr') => {
    const original = console[method].bind(console);
    console[method] = ((...args: Parameters<typeof format>) => {
      const capture = requestCapture.getStore()?.[stream];
      if (!capture) { original(...args); return; }
      capture(`${format(...args)}\n`);
    }) as typeof console[typeof method];
  };
  for (const method of ['log', 'info', 'debug'] as const) { wrapConsole(method, 'stdout'); }
  for (const method of ['warn', 'error'] as const) { wrapConsole(method, 'stderr'); }
}

/** Capture request-scoped console/raw writes without mixing concurrent executions. */
export async function withInProcessOutputCapture<T>(
  secrets: readonly string[],
  emit: (message: string, stream: 'stdout' | 'stderr') => void,
  run: () => Promise<T>,
): Promise<T> {
  installRequestScopedStdoutCapture();
  const capture: RequestCapture = {
    stdout: createWorkerOutputCapture('stdout', emit, secrets),
    stderr: createWorkerOutputCapture('stderr', emit, secrets),
  };
  return requestCapture.run(capture, async () => {
    try { return await run(); }
    finally { capture.stdout.flush(); capture.stderr.flush(); }
  });
}
