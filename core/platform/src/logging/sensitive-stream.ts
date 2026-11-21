export type SensitiveTextRedactor = (text: string, secrets: readonly string[]) => string;

export interface SensitiveStreamCapture {
  write(chunk: string | Uint8Array): void;
  flush(): void;
}

/** Redact secrets before splitting a stream into lines or carriage-return frames. */
export function createSensitiveStreamCapture(
  secrets: readonly string[],
  emit: (frame: string) => void,
  redact: SensitiveTextRedactor = (text, values) => [...values]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((result, secret) => result.split(secret).join('[REDACTED]'), text),
): SensitiveStreamCapture {
  let pending = '';
  const flushPending = (flush: boolean): void => {
    const carry = flush ? 0 : secrets.reduce((longest, secret) => {
      const limit = Math.min(Math.max(0, secret.length - 1), pending.length);
      for (let length = limit; length > longest; length -= 1) {
        if (pending.endsWith(secret.slice(0, length))) { return length; }
      }
      return longest;
    }, 0);
    let safeLength = pending.length - carry;
    if (!flush) {
      for (const secret of secrets) {
        if (!secret) { continue; }
        let index = pending.indexOf(secret);
        while (index !== -1) {
          if (index < safeLength && index + secret.length > safeLength) { safeLength = index; }
          index = pending.indexOf(secret, index + 1);
        }
      }
    }
    if (!safeLength) { return; }
    const safe = pending.slice(0, safeLength);
    pending = pending.slice(safeLength);
    for (const frame of redact(safe, secrets).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/[\r\n]+/)) {
      if (frame.trim()) { emit(frame); }
    }
  };
  return {
    write(chunk) {
      pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      flushPending(false);
    },
    flush() { flushPending(true); },
  };
}
