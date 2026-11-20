import { describe, it, expect, vi } from 'vitest';
import { ExecutionHandler } from '../handlers/execution-handler.js';

describe('ExecutionHandler Marketplace authority', () => {
  it('fails closed when the agent has no explicit plugin allowlist', async () => {
    const handler = new ExecutionHandler({
      allowedPaths: ['/tmp/test-workspace'],
      gatewayTransport: { send: vi.fn(), close: vi.fn() } as never,
      executionMode: 'in-process',
      timeoutMs: 5000,
      namespaceId: 'test-ns',
      marketplacePins: [],
    });
    try {
      await expect(handler.handle({
        type: 'call', requestId: 'req-1', adapter: 'execution', method: 'execute',
        args: [{
          executionId: 'exec-no-allowlist', requestId: 'req-1', projectId: 'project-1',
          namespaceId: 'test-ns', pluginId: '@test/sample', commandPath: 'sample run', input: {},
          descriptor: { permissions: { fs: { write: ['.'] } } },
          handlerRef: '/tmp/untrusted.js',
        }],
      })).rejects.toThrow(/Plugin not allowed by Host Agent policy/);
    } finally {
      handler.stop();
    }
  });

  it('rejects a namespace outside the local agent configuration', async () => {
    const handler = new ExecutionHandler({
      allowedPaths: ['/tmp/test-workspace'],
      gatewayTransport: { send: vi.fn(), close: vi.fn() } as never,
      executionMode: 'in-process',
      timeoutMs: 5000,
      allowedPlugins: ['@test/sample'],
      namespaceId: 'configured-ns',
      marketplacePins: [],
    });
    try {
      await expect(handler.handle({
        type: 'call', requestId: 'req-2', adapter: 'execution', method: 'execute',
        args: [{
          executionId: 'exec-wrong-ns', requestId: 'req-2', projectId: 'project-1',
          namespaceId: 'forged-ns', pluginId: '@test/sample', commandPath: 'sample run', input: {},
        }],
      })).rejects.toThrow(/namespace is not authorized/);
    } finally {
      handler.stop();
    }
  });
});
