import { createSensitiveStreamCapture } from '@kb-labs/core-platform';

export interface WorkerOutputCapture {
  (chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean;
  flush(): void;
}

export function redactSensitiveValue<T>(value: T, secrets: readonly string[]): T {
  const redact = (text: string): string => [...secrets]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((result, secret) => result.split(secret).join('[REDACTED]'), text);
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') { return redact(item); }
    if (item instanceof Error) {
      return { name: redact(item.name), message: redact(item.message), ...(item.stack ? { stack: redact(item.stack) } : {}), ...(item.cause !== undefined ? { cause: visit(item.cause) } : {}) };
    }
    if (Array.isArray(item)) { return item.map(visit); }
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, nested]) => [redact(key), visit(nested)]));
    }
    return item;
  };
  return visit(value) as T;
}

/** Capture plugin output for its host stream without writing to inherited stdio. */
export function createWorkerOutputCapture(
  stream: 'stdout' | 'stderr',
  emit: (line: string, stream: 'stdout' | 'stderr') => void,
  secrets: readonly string[],
  redact: (text: string, secrets: readonly string[]) => string = (text, values) => [...values]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((result, secret) => result.split(secret).join('[REDACTED]'), text),
): WorkerOutputCapture {
  const capture = createSensitiveStreamCapture(secrets, (frame) => emit(frame, stream), redact);

  const write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
    capture.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8'));

    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    done?.(null);
    return true;
  }) as WorkerOutputCapture;

  write.flush = () => capture.flush();
  return write;
}
