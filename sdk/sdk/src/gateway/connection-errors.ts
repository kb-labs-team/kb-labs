const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/** Match the Node fetch/undici network error codes used by Gateway clients. */
export function isGatewayConnectionFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = errorCode(current);
    if (code !== undefined && CONNECTION_ERROR_CODES.has(code)) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
