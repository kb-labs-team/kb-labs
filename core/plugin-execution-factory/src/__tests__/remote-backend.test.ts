import { describe, it, expect, vi } from 'vitest';
import { RemoteBackend } from '../backends/remote.js';
import type { IExecutionTransport, TransportExecutionResult } from '@kb-labs/core-platform';
import type { ExecutionRequest } from '../types.js';

// Minimal valid ExecutionRequest for testing
function makeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    executionId: 'exec-001',
    handlerRef: './dist/handler.js',
    pluginRoot: '/host/workspace',
    input: { key: 'value' },
    descriptor: { hostType: 'workflow' } as unknown as ExecutionRequest['descriptor'],
    ...overrides,
  };
}

function makeTransport(result: unknown = { answer: 42 }): IExecutionTransport {
  return {
    execute: vi.fn().mockResolvedValue({ data: result } satisfies TransportExecutionResult),
  };
}

describe('RemoteBackend', () => {
  describe('execute', () => {
    it('delegates to transport and returns data', async () => {
      const transport = makeTransport({ answer: 42 });
      const backend = new RemoteBackend({ transport });

      const result = await backend.execute(makeRequest());

      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ answer: 42 });
      expect(transport.execute).toHaveBeenCalledOnce();
    });

    it('returns ok:false when transport throws', async () => {
      const transport: IExecutionTransport = {
        execute: vi.fn().mockRejectedValue(new Error('connection refused')),
      };
      const backend = new RemoteBackend({ transport });

      const result = await backend.execute(makeRequest());

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('KB_RUNTIME_UNEXPECTED');
      expect(result.error?.message).not.toContain('connection refused');
    });

    it('passes the (possibly remapped) request to transport', async () => {
      const transport = makeTransport();
      const backend = new RemoteBackend({
        transport,
        workspaceRootOnHost: '/host/workspace',
      });

      await backend.execute(makeRequest({
        handlerRef: '/host/workspace/dist/handler.js',
        pluginRoot: '/host/workspace',
      }));

      const passedRequest = (transport.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ExecutionRequest;
      expect(passedRequest.handlerRef).toBe('/workspace/dist/handler.js');
      expect(passedRequest.pluginRoot).toBe('/workspace');
    });

    it('does not expose a roadmap-only mode in public metadata', async () => {
      const backend = new RemoteBackend({ transport: makeTransport() });
      const result = await backend.execute(makeRequest({ target: { environmentId: 'env_1' } }));

      expect(result.metadata?.['backend']).toBeUndefined();
      expect((result.metadata?.['target'] as Record<string, unknown>)?.['environmentId']).toBe('env_1');
    });

    it('does not expose a roadmap-only mode in failure metadata', async () => {
      const backend = new RemoteBackend({
        transport: { execute: vi.fn().mockRejectedValue(new Error('err')) },
      });
      const result = await backend.execute(makeRequest());
      expect(result.metadata?.['backend']).toBeUndefined();
    });
  });

  describe('handlerRef remapping', () => {
    it('remaps absolute host path to /workspace', async () => {
      const transport = makeTransport();
      const backend = new RemoteBackend({ transport, workspaceRootOnHost: '/host/workspace' });

      await backend.execute(makeRequest({
        handlerRef: '/host/workspace/dist/my-handler.js',
        pluginRoot: '/host/workspace',
      }));

      const req = (transport.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ExecutionRequest;
      expect(req.handlerRef).toBe('/workspace/dist/my-handler.js');
      expect(req.pluginRoot).toBe('/workspace');
    });

    it('does not remap when workspaceRootOnHost is not set', async () => {
      const transport = makeTransport();
      const backend = new RemoteBackend({ transport });

      const request = makeRequest({ handlerRef: '/host/workspace/dist/handler.js' });
      await backend.execute(request);

      const req = (transport.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ExecutionRequest;
      expect(req.handlerRef).toBe('/host/workspace/dist/handler.js');
    });

    it('does not send a caller-local platform root to a remote runtime', async () => {
      const transport = makeTransport();
      const backend = new RemoteBackend({ transport, workspaceRootOnHost: '/host/workspace' });

      await backend.execute(makeRequest({ platformRoot: '/Users/developer/kb-platform' }));

      const req = (transport.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ExecutionRequest;
      expect(req).not.toHaveProperty('platformRoot');
    });

    it('does not remap relative handlerRef', async () => {
      const transport = makeTransport();
      const backend = new RemoteBackend({ transport, workspaceRootOnHost: '/host/workspace' });

      await backend.execute(makeRequest({ handlerRef: './dist/handler.js' }));

      const req = (transport.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ExecutionRequest;
      expect(req.handlerRef).toBe('./dist/handler.js');
    });

    it('strips trailing slash from workspaceRootOnHost', async () => {
      const transport = makeTransport();
      const backend = new RemoteBackend({ transport, workspaceRootOnHost: '/host/workspace/' });

      await backend.execute(makeRequest({ handlerRef: '/host/workspace/dist/h.js' }));

      const req = (transport.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ExecutionRequest;
      expect(req.handlerRef).toBe('/workspace/dist/h.js');
    });
  });

  describe('stats', () => {
    it('accumulates after executions', async () => {
      const backend = new RemoteBackend({ transport: makeTransport() });
      await backend.execute(makeRequest());
      await backend.execute(makeRequest());

      const stats = await backend.stats();
      expect(stats.totalExecutions).toBe(2);
      expect(stats.successCount).toBe(2);
      expect(stats.errorCount).toBe(0);
    });

    it('counts errors separately', async () => {
      const transport: IExecutionTransport = { execute: vi.fn().mockRejectedValue(new Error('x')) };
      const backend = new RemoteBackend({ transport });
      await backend.execute(makeRequest());

      const stats = await backend.stats();
      expect(stats.errorCount).toBe(1);
      expect(stats.successCount).toBe(0);
    });
  });

  describe('health / shutdown', () => {
    it('health returns healthy:true', async () => {
      const backend = new RemoteBackend({ transport: makeTransport() });
      const h = await backend.health();
      expect(h.healthy).toBe(true);
      expect(h.backend).toBe('remote');
    });

    it('shutdown resolves without throwing', async () => {
      const backend = new RemoteBackend({ transport: makeTransport() });
      await expect(backend.shutdown()).resolves.toBeUndefined();
    });
  });
});
