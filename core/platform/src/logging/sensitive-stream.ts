export type SensitiveTextRedactor = (text: string, secrets: readonly string[]) => string;

const defaultRedactor: SensitiveTextRedactor = (text, values) => [...values]
  .filter(Boolean)
  .sort((left, right) => right.length - left.length)
  .reduce((result, secret) => result.split(secret).join('[REDACTED]'), text);

function getSafePrefixLength(pending: string, secrets: readonly string[], flush: boolean): number {
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
  return safeLength;
}

export function redactSensitiveText(text: string, secrets: readonly string[]): string {
  return defaultRedactor(text, secrets);
}

export interface SensitiveTextStream {
  write(chunk: string | Uint8Array): string;
  flush(): string;
}

/** Redact complete values while holding a possible secret prefix across writes. */
export function createSensitiveTextStream(
  secrets: readonly string[],
  redact: SensitiveTextRedactor = defaultRedactor,
): SensitiveTextStream {
  let pending = '';
  const takeSafe = (flush: boolean): string => {
    const safeLength = getSafePrefixLength(pending, secrets, flush);
    if (!safeLength) { return ''; }
    const safe = pending.slice(0, safeLength);
    pending = pending.slice(safeLength);
    return redact(safe, secrets);
  };
  return {
    write(chunk) {
      pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return takeSafe(false);
    },
    flush() { return takeSafe(true); },
  };
}

export interface SensitiveStreamCapture {
  write(chunk: string | Uint8Array): void;
  flush(): void;
}

/** Redact secrets before splitting a stream into lines or carriage-return frames. */
export function createSensitiveStreamCapture(
  secrets: readonly string[],
  emit: (frame: string) => void,
  redact: SensitiveTextRedactor = defaultRedactor,
): SensitiveStreamCapture {
  const redactor = createSensitiveTextStream(secrets, redact);
  const splitFrames = (safe: string) => {
    for (const frame of safe.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/[\r\n]+/)) {
      if (frame.trim()) { emit(frame); }
    }
  };
  return {
    write(chunk) { splitFrames(redactor.write(chunk)); },
    flush() { splitFrames(redactor.flush()); },
  };
}
