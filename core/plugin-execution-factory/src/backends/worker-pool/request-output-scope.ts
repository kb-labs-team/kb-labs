import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';
import type { WorkerOutputCapture } from './output-capture.js';

interface RequestOutput {
  stdout: WorkerOutputCapture;
  stderr: WorkerOutputCapture;
  active: boolean;
}

const requestOutput = new AsyncLocalStorage<RequestOutput>();
let installed = false;

function installRequestOutputRouting(): void {
  if (installed) { return; }
  installed = true;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const capture = requestOutput.getStore();
    if (capture?.active) { return capture.stdout(chunk, encoding, callback); }
    if (!capture) { return originalStdoutWrite(chunk as never, encoding as never, callback as never); }
    if (typeof encoding === 'function') { encoding(null); } else { callback?.(null); }
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const capture = requestOutput.getStore();
    if (capture?.active) { return capture.stderr(chunk, encoding, callback); }
    if (!capture) { return originalStderrWrite(chunk as never, encoding as never, callback as never); }
    if (typeof encoding === 'function') { encoding(null); } else { callback?.(null); }
    return true;
  }) as typeof process.stderr.write;
  const wrapConsole = (method: 'log' | 'info' | 'debug' | 'warn' | 'error', stream: 'stdout' | 'stderr') => {
    const original = console[method].bind(console);
    console[method] = ((...args: Parameters<typeof format>) => {
      const capture = requestOutput.getStore();
      if (!capture) { original(...args); return; }
      if (capture.active) { capture[stream](`${format(...args)}\n`); }
    }) as typeof console[typeof method];
  };
  for (const method of ['log', 'info', 'debug'] as const) { wrapConsole(method, 'stdout'); }
  for (const method of ['warn', 'error'] as const) { wrapConsole(method, 'stderr'); }
}

/** Keep output tied to its originating execution, even after it returns. */
export async function withWorkerRequestOutputScope<T>(
  stdout: WorkerOutputCapture,
  stderr: WorkerOutputCapture,
  run: () => Promise<T>,
): Promise<T> {
  installRequestOutputRouting();
  const state: RequestOutput = { stdout, stderr, active: true };
  return requestOutput.run(state, async () => {
    try { return await run(); }
    finally {
      stdout.flush();
      stderr.flush();
      state.active = false;
    }
  });
}
