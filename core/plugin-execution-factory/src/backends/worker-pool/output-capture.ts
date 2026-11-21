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
  let pending = '';

  const emitFrames = (text: string): void => {
    for (const frame of redact(text, secrets).replace(ansi, '').split(/[\r\n]+/)) {
      if (frame.trim()) { emit(frame, stream); }
    }
  };

  const drainSafePrefix = (flush: boolean): void => {
    // Retain only a suffix that could begin a secret completed by a future
    // write. This avoids leaking a secret split across either writes or frame
    // delimiters while keeping bare-CR progress frames responsive.
    const carry = flush ? 0 : secrets.reduce((longest, secret) => {
      const limit = Math.min(secret.length - 1, pending.length);
      for (let length = limit; length > longest; length -= 1) {
        if (pending.endsWith(secret.slice(0, length))) { return length; }
      }
      return longest;
    }, 0);
    let safeLength = pending.length - carry;
    if (!flush) {
      // A complete secret can start just before the pending partial-prefix
      // suffix and cross that boundary. Keep it whole so replacement occurs
      // before any part of it is forwarded.
      for (const secret of secrets) {
        if (!secret) { continue; }
        let index = pending.indexOf(secret);
        while (index !== -1) {
          if (index < safeLength && index + secret.length > safeLength) {
            safeLength = index;
          }
          index = pending.indexOf(secret, index + 1);
        }
      }
    }
    if (safeLength === 0) { return; }
    const safe = pending.slice(0, safeLength);
    pending = pending.slice(safeLength);
    emitFrames(redact(safe, secrets));
  };

  const write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
    pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8');
    drainSafePrefix(false);

    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    done?.(null);
    return true;
  }) as WorkerOutputCapture;

  write.flush = () => drainSafePrefix(true);
  return write;
}
