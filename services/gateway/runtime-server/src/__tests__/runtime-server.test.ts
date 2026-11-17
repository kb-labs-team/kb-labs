/**
 * Tests for RuntimeServer — plugin execution via Gateway WS protocol.
 *
 * Uses a mock GatewayClient to test handler registration and execution logic
 * without requiring a real WS connection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CapabilityCall } from '@kb-labs/host-agent-contracts';

// --- Mocks ---

const gatewayClientState = vi.hoisted(() => ({
  onConnected: vi.fn<(hostId: string, sessionId: string) => void>(),
}));
const mockRegisterHandler = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn();

vi.mock('@kb-labs/host-agent-core', () => ({
  GatewayClient: class {
    constructor(options: { onConnected?: (hostId: string, sessionId: string) => void }) {
      gatewayClientState.onConnected.mockImplementation(options.onConnected ?? (() => {}));
    }

    registerHandler = mockRegisterHandler;
    connect = mockConnect;
    stop = mockStop;
  },
}));

const mockRunInProcess = vi.fn();
vi.mock('@kb-labs/plugin-runtime', () => ({
  runInProcess: mockRunInProcess,
}));

vi.mock('@kb-labs/plugin-contracts', () => ({
  noopUI: {},
}));

// --- Helpers ---

function makeCall(overrides: Partial<CapabilityCall> = {}): CapabilityCall {
  return {
    type: 'call',
    requestId: 'req-001',
    adapter: 'execution',
    method: 'execute',
    args: [{
      executionId: 'exec-001',
      handlerRef: '/workspace/dist/handler.js',
      pluginRoot: '/workspace',
      input: { x: 1 },
      descriptor: { hostType: 'workflow' },
    }],
    ...overrides,
  };
}

// --- Tests ---

describe('RuntimeServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunInProcess.mockResolvedValue({ data: { result: 'ok' }, executionMeta: {} });
  });

  // Lazy import to ensure mocks are in place
  async function createServer() {
    const { RuntimeServer } = await import('../runtime-server.js');
    return new RuntimeServer({
      gatewayUrl: 'http://localhost:4000',
      getAccessToken: () => 'token-abc',
      platformRoot: process.cwd(),
    });
  }

  it('registers execution handler on construction', async () => {
    await createServer();
    expect(mockRegisterHandler).toHaveBeenCalledWith('execution', expect.any(Function));
  });

  it('calls GatewayClient.connect() on start()', async () => {
    const server = await createServer();
    await server.start();
    expect(mockConnect).toHaveBeenCalledOnce();
  });

  it('calls GatewayClient.stop() on stop()', async () => {
    const server = await createServer();
    server.stop();
    expect(mockStop).toHaveBeenCalledOnce();
  });

  describe('handleExecution', () => {
    async function getHandler() {
      await createServer();
      // Extract the registered handler from the mock
      const [, handler] = mockRegisterHandler.mock.calls[0] as [string, (call: CapabilityCall) => Promise<unknown>];
      return handler;
    }

    it('calls runInProcess with correct params and returns data', async () => {
      const handler = await getHandler();
      const result = await handler(makeCall());

      expect(mockRunInProcess).toHaveBeenCalledOnce();
      const callArgs = mockRunInProcess.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs['handlerPath']).toBe('/workspace/dist/handler.js');
      expect(callArgs['pluginRoot' as keyof typeof callArgs] ?? callArgs['cwd']).toBeTruthy();
      expect(callArgs['input']).toEqual({ x: 1 });
      expect(callArgs['platformRoot']).toBe(process.cwd());

      expect(result).toEqual({ result: 'ok' });
    });

    it('throws when method is not execute', async () => {
      const handler = await getHandler();
      await expect(handler(makeCall({ method: 'unknown' }))).rejects.toThrow(
        'Unknown execution method: unknown',
      );
    });

    it('throws when handlerRef is missing', async () => {
      const handler = await getHandler();
      const call = makeCall({ args: [{ executionId: 'e1', pluginRoot: '/workspace', input: {} }] });
      await expect(handler(call)).rejects.toThrow('Missing required fields');
    });

    it('throws when pluginRoot is missing', async () => {
      const handler = await getHandler();
      const call = makeCall({ args: [{ executionId: 'e1', handlerRef: '/workspace/h.js', input: {} }] });
      await expect(handler(call)).rejects.toThrow('Missing required fields');
    });

    it('propagates runInProcess errors', async () => {
      mockRunInProcess.mockRejectedValue(new Error('handler crashed'));
      const handler = await getHandler();
      await expect(handler(makeCall())).rejects.toThrow('handler crashed');
    });

    it('handles relative handlerRef (resolved against pluginRoot)', async () => {
      const handler = await getHandler();
      await handler(makeCall({
        args: [{
          executionId: 'e1',
          handlerRef: 'dist/handler.js', // relative, no leading /
          pluginRoot: '/workspace',
          input: {},
          descriptor: {},
        }],
      }));

      const callArgs = mockRunInProcess.mock.calls[0]![0] as Record<string, unknown>;
      // Should resolve to /workspace/dist/handler.js
      expect(callArgs['handlerPath']).toContain('/workspace/dist/handler.js');
    });
  });

  describe('getHostId', () => {
    it('returns null before connected', async () => {
      const server = await createServer();
      expect(server.getHostId()).toBeNull();
    });

    it('returns hostId after onConnected callback', async () => {
      const { RuntimeServer } = await import('../runtime-server.js');

      const server = new RuntimeServer({
        gatewayUrl: 'http://localhost:4000',
        getAccessToken: () => 'token',
      });

      expect(server.getHostId()).toBeNull();
      gatewayClientState.onConnected('host_runtime_xyz', 'sess-1');
      expect(server.getHostId()).toBe('host_runtime_xyz');
    });
  });
});
