/**
 * Tests for createIsolatedExecutionBackend.
 *
 * Key behaviour:
 *   - Without strictIsolation → returns plain local backend
 *   - With strictIsolation + environmentId → routes to RemoteBackend (fresh per-job via factory)
 *   - With strictIsolation + no environmentId → routes to local backend
 *   - Remote factory called once per-job (not shared)
 */
import { describe, it, expect, vi } from 'vitest';
import { containerUnavailableError, createIsolatedExecutionBackend, requireAttachedEnvironmentProvider, ContainerProviderUnavailableError } from '../isolated-backend.js';
import { EnvironmentProvisioningError, EnvironmentTeardownError } from '@kb-labs/core-platform';
import type { RemoteJobContext } from '../isolated-backend.js';
import type { IExecutionTransport } from '@kb-labs/core-platform';
import type { ExecutionRequest } from '../types.js';

const platform = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, flush: async () => {}, child: () => ({}) },
  cache: { get: async () => null, set: async () => {}, delete: async () => {}, clear: async () => {} },
  config: {},
} as unknown as Parameters<typeof createIsolatedExecutionBackend>[0]['localBackend']['platform'];

function makeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    executionId: 'exec-001',
    handlerRef: './dist/handler.js',
    pluginRoot: '/tmp/plugin',
    input: {},
    descriptor: {
      hostType: 'workflow',
      pluginId: '@kb-labs/test-plugin',
      pluginVersion: '1.0.0',
      requestId: 'request-001',
      permissions: {},
    } as unknown as ExecutionRequest['descriptor'],
    ...overrides,
  };
}

function makeTransport(label = 'remote'): IExecutionTransport {
  return { execute: vi.fn().mockResolvedValue({ data: label }) };
}

describe('createIsolatedExecutionBackend', () => {
  describe('without strictIsolation', () => {
    it('returns a backend that has health/stats/shutdown', () => {
      const backend = createIsolatedExecutionBackend({ localBackend: { platform } });
      expect(typeof backend.execute).toBe('function');
      expect(typeof backend.health).toBe('function');
      expect(typeof backend.stats).toBe('function');
      expect(typeof backend.shutdown).toBe('function');
    });

    it('shutdown resolves without throwing', async () => {
      const backend = createIsolatedExecutionBackend({ localBackend: { platform } });
      await expect(backend.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('with strictIsolation', () => {
    it('reports container as the platform execution mode while routing through isolation', async () => {
      const backend = createIsolatedExecutionBackend({
        localBackend: { platform, mode: 'in-process' },
        executionMode: 'container',
        strictIsolation: { buildTransport: () => makeTransport() },
      });

      expect(backend.executionMode).toBe('container');
      await backend.shutdown();
    });

    it('routes to remote when request.target.environmentId is present', async () => {
      const transport = makeTransport('remote-result');
      const buildTransport = vi.fn().mockReturnValue(transport);

      const backend = createIsolatedExecutionBackend({
        localBackend: { platform },
        strictIsolation: { buildTransport },
      });

      const result = await backend.execute(makeRequest({ target: { environmentId: 'env-abc', namespace: 'ns-1' } }));

      expect(buildTransport).toHaveBeenCalledWith<[RemoteJobContext]>({
        runtimeHostId: 'env-abc',
        namespaceId: 'ns-1',
      });
      expect(transport.execute).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
      expect(result.metadata?.['backend']).toBe(backend.executionMode);
    });

    it('routes to local when no environmentId', async () => {
      vi.mock('@kb-labs/plugin-runtime', () => ({
        runInProcess: vi.fn().mockResolvedValue({ data: 'local-result', executionMeta: {} }),
      }));
      vi.mock('node:fs', async (importOriginal) => {
        // eslint-disable-next-line @typescript-eslint/consistent-type-imports
        const actual = await importOriginal<typeof import('node:fs')>();
        return { ...actual, existsSync: vi.fn().mockReturnValue(true) };
      });

      const transport = makeTransport();
      const buildTransport = vi.fn().mockReturnValue(transport);

      const backend = createIsolatedExecutionBackend({
        localBackend: { platform },
        strictIsolation: { buildTransport },
      });

      await backend.execute(makeRequest()); // no target at all

      expect(buildTransport).not.toHaveBeenCalled();
      expect(transport.execute).not.toHaveBeenCalled();
    });

    it('routes to local when target has no environmentId', async () => {
      vi.mock('@kb-labs/plugin-runtime', () => ({
        runInProcess: vi.fn().mockResolvedValue({ data: null, executionMeta: {} }),
      }));

      const transport = makeTransport();
      const buildTransport = vi.fn().mockReturnValue(transport);

      const backend = createIsolatedExecutionBackend({
        localBackend: { platform },
        strictIsolation: { buildTransport },
      });

      await backend.execute(makeRequest({ target: { workspaceId: 'ws-123' } })); // no environmentId

      expect(buildTransport).not.toHaveBeenCalled();
      expect(transport.execute).not.toHaveBeenCalled();
    });

    it('creates a fresh remote backend per-job (factory called each time)', async () => {
      const t1 = makeTransport('job-1');
      const t2 = makeTransport('job-2');
      let callCount = 0;
      const buildTransport = vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? t1 : t2;
      });

      const backend = createIsolatedExecutionBackend({
        localBackend: { platform },
        strictIsolation: { buildTransport },
      });

      await backend.execute(makeRequest({ target: { environmentId: 'env-1', namespace: 'ns-a' } }));
      await backend.execute(makeRequest({ target: { environmentId: 'env-2', namespace: 'ns-b' } }));

      expect(buildTransport).toHaveBeenCalledTimes(2);
      expect(buildTransport).toHaveBeenNthCalledWith<[RemoteJobContext]>(1, { runtimeHostId: 'env-1', namespaceId: 'ns-a' });
      expect(buildTransport).toHaveBeenNthCalledWith<[RemoteJobContext]>(2, { runtimeHostId: 'env-2', namespaceId: 'ns-b' });
      expect(t1.execute).toHaveBeenCalledOnce();
      expect(t2.execute).toHaveBeenCalledOnce();
    });

    it('passes workspaceRootOnHost to RemoteBackend', async () => {
      const transport = makeTransport();
      const buildTransport = vi.fn().mockReturnValue(transport);

      // workspaceRootOnHost is used internally in RemoteBackend for path remapping.
      // We verify it doesn't throw and transport is called correctly.
      const backend = createIsolatedExecutionBackend({
        localBackend: { platform },
        strictIsolation: { buildTransport, workspaceRootOnHost: '/host/monorepo' },
      });

      const result = await backend.execute(makeRequest({ target: { environmentId: 'env-xyz' } }));
      expect(result.ok).toBe(true);
      expect(buildTransport).toHaveBeenCalledWith<[RemoteJobContext]>({ runtimeHostId: 'env-xyz', namespaceId: 'default' });
    });

    it('health/stats delegate to local backend', () => {
      const backend = createIsolatedExecutionBackend({
        localBackend: { platform },
        strictIsolation: { buildTransport: vi.fn().mockReturnValue(makeTransport()) },
      });

      expect(() => backend.health()).not.toThrow();
      expect(() => backend.stats()).not.toThrow();
    });

    it('shutdown delegates to local backend', async () => {
      const backend = createIsolatedExecutionBackend({
        localBackend: { platform },
        strictIsolation: { buildTransport: vi.fn().mockReturnValue(makeTransport()) },
      });

      await expect(backend.shutdown()).resolves.toBeUndefined();
    });
  });

  // case: S-244.4
  it('does not route container mode to local execution without a provisioner', async () => {
    const backend = createIsolatedExecutionBackend({
      localBackend: { platform, mode: 'in-process' },
      executionMode: 'container',
      strictIsolation: { buildTransport: () => makeTransport() },
    });

    const result = await backend.execute(makeRequest());

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'KB_RUNTIME_CONTAINER_UNAVAILABLE' });

    const withoutIsolation = createIsolatedExecutionBackend({
      localBackend: { platform, mode: 'in-process' },
      executionMode: 'container',
    });
    const unconfiguredResult = await withoutIsolation.execute(makeRequest());
    expect(unconfiguredResult.ok).toBe(false);
    expect(unconfiguredResult.error).toMatchObject({ code: 'KB_RUNTIME_CONTAINER_UNAVAILABLE' });
  });

  // case: S-244.4
  it('preserves the catalogued container-unavailable error when provisioning fails', async () => {
    const backend = createIsolatedExecutionBackend({
      localBackend: { platform, mode: 'in-process' },
      executionMode: 'container',
      strictIsolation: {
        buildTransport: () => makeTransport(),
        provisionEnvironment: async () => {
          throw containerUnavailableError(
            new EnvironmentProvisioningError('daemon-unreachable', 'node:20-alpine', new Error('socket refused')),
          );
        },
      },
    });

    const result = await backend.execute(makeRequest());

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'KB_RUNTIME_CONTAINER_UNAVAILABLE' });
  });

  // case: S-244.7
  it('refuses a network-declaring plugin before container provisioning or local fallback', async () => {
    const provisionEnvironment = vi.fn();
    const backend = createIsolatedExecutionBackend({
      localBackend: { platform, mode: 'in-process' },
      executionMode: 'container',
      strictIsolation: {
        buildTransport: () => makeTransport(),
        provisionEnvironment,
      },
    });
    const request = makeRequest({
      descriptor: {
        ...makeRequest().descriptor,
        permissions: { network: { fetch: ['https://api.example.test'] } },
      },
    });

    const result = await backend.execute(request);

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'KB_RUNTIME_CONTAINER_NETWORK_UNSUPPORTED' });
    expect(provisionEnvironment).not.toHaveBeenCalled();
  });

  // case: S-244.4
  it('renders cause-specific diagnostics with the configured image and exact remediation', () => {
    const daemonError = containerUnavailableError(
      new EnvironmentProvisioningError('daemon-unreachable', 'registry.test/plugin:4', new Error('socket refused')),
    );
    expect(daemonError.envelope.code).toBe('KB_RUNTIME_CONTAINER_UNAVAILABLE');
    expect(daemonError.envelope.hint).toContain('registry.test/plugin:4');
    expect(daemonError.envelope.hint).toContain('docker info');
    expect(daemonError.envelope.hint).not.toContain('<configured-image>');

    const imageError = containerUnavailableError(
      new EnvironmentProvisioningError('image-unavailable', 'registry.test/plugin:4', new Error('pull refused')),
    );
    expect(imageError.envelope.hint).toContain('docker pull registry.test/plugin:4');
  });

  it.each([
    ['no environment provider', undefined, 'provider-missing', 'not configured'],
    ['provider without attached start support', {}, 'attached-start-unsupported', 'does not support attached reserve()/start()'],
  ])('maps %s through the container provider diagnostic owner', (_label, provider, failureCause, reason) => {
    let failure: unknown;
    try {
      requireAttachedEnvironmentProvider(provider);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ContainerProviderUnavailableError);
    expect(failure).toMatchObject({ failureCause });
    const diagnostic = containerUnavailableError(failure);
    expect(diagnostic.envelope.code).toBe('KB_RUNTIME_CONTAINER_UNAVAILABLE');
    expect(diagnostic.envelope.hint).toContain(reason);
    expect(diagnostic.envelope.hint).toContain('kb marketplace install @kb-labs/adapters-environment-docker --scope platform');
    expect(diagnostic.envelope.hint).not.toContain('Docker daemon logs');
  });

  // case: S-244.1
  it('renders the catalogued teardown failure with the daemon cause and exact container command', () => {
    const teardownError = containerUnavailableError(
      new EnvironmentTeardownError('kb-env-run-x', new Error('daemon removal conflict')),
    );
    expect(teardownError.envelope.code).toBe('KB_RUNTIME_CONTAINER_TEARDOWN_FAILED');
    expect(teardownError.envelope.cause).toBe('daemon removal conflict');
    expect(teardownError.envelope.hint).toContain('docker rm -f kb-env-run-x');
  });

  // case: S-244.1
  it('returns the catalogued teardown error when provisioned execution cleanup fails', async () => {
    const backend = createIsolatedExecutionBackend({
      localBackend: { platform, mode: 'in-process' },
      executionMode: 'container',
      strictIsolation: {
        buildTransport: () => makeTransport(),
        provisionEnvironment: async () => ({
          environmentId: 'runtime-teardown',
          namespace: 'default',
          cleanup: async () => {
            throw new EnvironmentTeardownError('kb-env-run-x', new Error('daemon removal conflict'));
          },
        }),
      },
    });

    const result = await backend.execute(makeRequest());

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: 'KB_RUNTIME_CONTAINER_TEARDOWN_FAILED',
      cause: 'daemon removal conflict',
      hint: expect.stringContaining('docker rm -f kb-env-run-x'),
    });
  });
});
