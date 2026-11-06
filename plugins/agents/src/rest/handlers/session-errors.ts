import { PluginError } from '@kb-labs/sdk';

export function agentSessionNotFound(sessionId: string): PluginError {
  return new PluginError(
    `Agent session ${sessionId} was not found.`,
    'KB_RUNTIME_RESOURCE_NOT_FOUND',
    { plugin: '@kb-labs/agents', sessionId },
  );
}
