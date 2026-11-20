import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createProxyPlatform: vi.fn(),
  resolveMarketplace: vi.fn(),
  runInProcess: vi.fn(),
  runInSubprocess: vi.fn(),
}));

vi.mock('@kb-labs/core-runtime', () => ({ createProxyPlatform: mocks.createProxyPlatform }));
vi.mock('@kb-labs/plugin-runtime', () => ({
  runInProcess: mocks.runInProcess,
  runInSubprocess: mocks.runInSubprocess,
}));
vi.mock('../handlers/local-plugin-resolver.js', () => ({
  LocalPluginResolver: class {
    resolveMarketplace = mocks.resolveMarketplace;
    listPlugins = vi.fn();
  },
}));

import { ExecutionHandler } from '../handlers/execution-handler.js';

describe('ExecutionHandler subprocess transport', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('passes the Gateway proxy platform into the shared stdio subprocess runner', async () => {
    const proxyPlatform = { cache: { get: vi.fn() } };
    mocks.createProxyPlatform.mockResolvedValue(proxyPlatform);
    mocks.resolveMarketplace.mockResolvedValue({
      pluginRoot: '/plugins/sample', handlerPath: '/plugins/sample/handler.js#default', projectRoot: '/projects/sample',
      descriptor: {
        hostType: 'cli', pluginId: '@test/sample', pluginVersion: '1.0.0', requestId: 'req-stdio',
        handlerId: 'sample:run', permissions: {},
        hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
      },
    });
    mocks.runInSubprocess.mockResolvedValue({ data: 'executed' });
    const handler = new ExecutionHandler({
      gatewayTransport: { send: vi.fn(), close: vi.fn() } as never,
      allowedPaths: ['/plugins'],
      executionMode: 'subprocess',
      timeoutMs: 5000,
      allowedPlugins: ['@test/sample'],
      namespaceId: 'test-ns',
      marketplacePins: [{ package: '@test/sample', version: '1.0.0', integrity: 'sha512-fixture' }],
    });

    try {
      await expect(handler.handle({
        type: 'call', requestId: 'req-stdio', adapter: 'execution', method: 'execute',
        args: [{
          executionId: 'exec-stdio', requestId: 'req-stdio', projectId: 'project-sample',
          namespaceId: 'test-ns', pluginId: '@test/sample', commandPath: 'sample:run', input: {},
        }],
      })).resolves.toBe('executed');

      expect(mocks.runInSubprocess).toHaveBeenCalledWith(expect.objectContaining({ platform: proxyPlatform }));
    } finally {
      handler.stop();
    }
  });
});
