/**
 * Browser-safe hook for masking request-owned values in catalogued previews.
 * Node hosts install the request-aware redactor from logging/context; the
 * error-envelope subpath itself remains free of Node built-ins.
 */
let redact = (value: string): string => value;

export function setErrorPreviewRedactor(redactor: (value: string) => string): void {
  redact = redactor;
}

export function redactErrorPreview(value: string): string {
  return redact(value);
}
