import { RemoteAuthError, RemoteNotFoundError, RemoteOperationError } from './remote-verify-core.mjs';

export function classifyRemoteCliError(command, diagnostic, { retryable = false } = {}) {
  const status = diagnostic.match(/\bHTTP\s+(401|403|404)\b/i)?.[1];
  if (status === '401' || status === '403' || /permission[^\n]*denied|authentication failed/i.test(diagnostic)) {
    return new RemoteAuthError(`${command} operation denied: ${diagnostic}`);
  }
  if (status === '404') return new RemoteNotFoundError(`${command} resource not found: ${diagnostic}`);
  return new RemoteOperationError(`${command} operation failed: ${diagnostic}`, { retryable });
}
