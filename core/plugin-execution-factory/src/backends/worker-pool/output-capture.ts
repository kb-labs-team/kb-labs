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
  const ansi = /\x1b\[[0-9;]*[A-Za-z]/g;
  const maxSecretLength = Math.max(1, ...secrets.map((secret) => secret.length));
  let pending = '';

  const emitSafe = (text: string): void => {
    for (const line of redact(text, secrets).replace(ansi, '').split('\n')) {
      if (line.trim()) { emit(line, stream); }
    }
  };

  const write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
    pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) { emitSafe(line); }

    // Bound memory for a plugin that writes an unbroken stream. Keep enough
    // suffix to redact a secret split across the next write call.
    const maxPending = 64 * 1024;
    if (pending.length > maxPending) {
      const safePrefixLength = pending.length - Math.max(0, maxSecretLength - 1);
      emitSafe(pending.slice(0, safePrefixLength));
      pending = pending.slice(safePrefixLength);
    }

    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    done?.(null);
    return true;
  }) as WorkerOutputCapture;

  write.flush = () => {
    if (pending) { emitSafe(pending); pending = ''; }
  };
  return write;
}
