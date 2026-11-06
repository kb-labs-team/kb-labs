import { describe, it, expect, vi } from 'vitest';
import { ExecutionHandler } from '../handlers/execution-handler.js';

function makeHandler() {
  return new ExecutionHandler({
    allowedPaths: ['/tmp/test-workspace'],
    gatewayTransport: { send: vi.fn(), close: vi.fn() } as any,
    executionMode: 'in-process',
    timeoutMs: 5000,
  });
}

describe('ExecutionHandler — descriptor defaults', () => {
  it('defaults permissions when descriptor omits them', async () => {
    const handler = makeHandler();

    // This should NOT throw — permissions are defaulted
    // It will fail at plugin resolution (no real plugins), but not at validation
    const result = handler.handle({
      type: 'call',
      requestId: 'req-1',
      adapter: 'execution',
      method: 'execute',
      args: [{
        executionId: 'exec-default-perms',
        pluginId: '@test/nonexistent',
        handlerRef: 'dist/handler.js',
        input: {},
        descriptor: {
          pluginId: '@test/nonexistent',
          pluginVersion: '1.0.0',
          handlerId: 'handler',
          requestId: 'req-1',
          hostType: 'cli',
          hostContext: { host: 'cli' },
          // NO permissions — should be defaulted
        },
      }],
    });

    // Should fail at plugin resolution or later, NOT at 'descriptor.permissions is required'
    await expect(result).rejects.not.toThrow(/descriptor\.permissions is required/i);
  });
});
