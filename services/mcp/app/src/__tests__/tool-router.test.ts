import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlatformContainer } from '@kb-labs/core-runtime';
import type { McpTool } from '../mcp/tool-builder.js';
import { callOutput } from '../mcp/output-capture.js';

const executeCommandV3 = vi.fn();
vi.mock('@kb-labs/cli-runtime', () => ({
  executeCommandV3: (...args: unknown[]) => executeCommandV3(...args),
}));

const { callTool } = await import('../mcp/tool-router.js');

const tool: McpTool = {
  name: 'mind__mind_search',
  description: 'search',
  inputSchema: { type: 'object' },
  pluginId: 'mind',
  pluginRoot: '/plugins/mind',
  handlerPath: 'dist/commands/mind-search.js',
  version: '1.2.3',
  operationType: 'read',
  permissions: {},
};

// Minimal container — only the members callTool touches.
const container = {
  logger: { child: () => ({}) },
  getSocketPath: () => '/tmp/sock',
} as unknown as PlatformContainer;
const resolvePlatform = vi.fn(() => container);

describe('callTool', () => {
  beforeEach(() => {
    executeCommandV3.mockReset();
    resolvePlatform.mockClear();
  });

  it('reports success when the command exits 0', async () => {
    executeCommandV3.mockResolvedValue(0);
    const result = await callTool(tool, {}, 'tenant1', resolvePlatform);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('reports failure when the command exits non-zero', async () => {
    executeCommandV3.mockResolvedValue(1);
    const result = await callTool(tool, {}, 'tenant1', resolvePlatform);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('captures output written to the callOutput store (uiProvider path)', async () => {
    // Simulate what the execution backend's uiProvider does: it reads
    // callOutput.getStore() and pushes lines into it when the plugin calls ui.*.
    executeCommandV3.mockImplementation(async () => {
      callOutput.getStore()?.push('[info] hello from uiProvider');
      return 0;
    });
    const result = await callTool(tool, {}, 'tenant1', resolvePlatform);
    expect(result.output).toContain('hello from uiProvider');
  });

  it('captures worker stdout and structured logger output', async () => {
    executeCommandV3.mockImplementation(async (options: {
      onLog?: (entry: { message: string }) => void;
      onLoggerLog?: (entry: { level: string; message: string }) => void;
    }) => {
      options.onLog?.({ message: 'stdout line' });
      options.onLoggerLog?.({ level: 'info', message: 'logger line' });
      return 0;
    });
    const result = await callTool(tool, {}, 'tenant1', resolvePlatform);
    expect(result.output).toContain('stdout line');
    expect(result.output).toContain('[info] logger line');
  });

  it('activates the per-call AsyncLocalStorage context', async () => {
    let storeInsideCall: string[] | undefined;
    executeCommandV3.mockImplementation(async () => {
      storeInsideCall = callOutput.getStore();
      return 0;
    });
    await callTool(tool, {}, 'tenant1', resolvePlatform);
    expect(Array.isArray(storeInsideCall)).toBe(true);
  });

  it('isolated stores per concurrent call — outputs never mix', async () => {
    // Simulate two calls with different output.
    executeCommandV3
      .mockImplementationOnce(async () => {
        callOutput.getStore()?.push('output-A');
        return 0;
      })
      .mockImplementationOnce(async () => {
        callOutput.getStore()?.push('output-B');
        return 0;
      });

    const [a, b] = await Promise.all([
      callTool(tool, {}, 'tenantA', resolvePlatform),
      callTool(tool, {}, 'tenantB', resolvePlatform),
    ]);
    expect(a.output).toContain('output-A');
    expect(a.output).not.toContain('output-B');
    expect(b.output).toContain('output-B');
    expect(b.output).not.toContain('output-A');
  });

  it('passes plugin identity, flags and tenantId through to executeCommandV3', async () => {
    executeCommandV3.mockResolvedValue(0);
    await callTool(tool, { id: '42' }, 'tenant1', resolvePlatform);
    expect(executeCommandV3).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'mind',
        pluginVersion: '1.2.3',
        pluginRoot: '/plugins/mind',
        flags: { id: '42' },
        tenantId: 'tenant1',
        permissions: {},
      }),
    );
  });

  it('resolves the platform container through the tenant seam', async () => {
    executeCommandV3.mockResolvedValue(0);
    await callTool(tool, {}, 'tenant-xyz', resolvePlatform);
    expect(resolvePlatform).toHaveBeenCalledWith('tenant-xyz');
  });

  it('does not pollute global console (no withStdoutCapture)', async () => {
    const originalLog = console.log;
    executeCommandV3.mockResolvedValue(0);
    await callTool(tool, {}, 'tenant1', resolvePlatform);
    // console.log must be untouched — no global patching.
    expect(console.log).toBe(originalLog);
  });
});
