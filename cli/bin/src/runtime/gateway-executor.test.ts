import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IGatewayClient } from '@kb-labs/sdk/gateway';
import { executeViaGateway } from './gateway-executor.js';

const render = vi.hoisted(() => vi.fn());
const finish = vi.hoisted(() => vi.fn());
vi.mock('@kb-labs/cli-runtime/gateway', () => ({
  HttpSseGatewayTransport: class {},
  resolveTransport: vi.fn(),
  TerminalEventRenderer: class {
    render = render;
    finish = finish;
  },
}));

describe('secured project runtime command execution', () => {
  afterEach(() => { vi.restoreAllMocks(); delete process.env.KB_OUTPUT_MODE; });

  // case: S-160.1
  it('uses project identity and canonical command instead of sending a client handler reference', async () => {
    process.env.KB_OUTPUT_MODE = 'json';
    const event = { type: 'execution:done', requestId: 'req-1', executionId: 'exec-1', exitCode: 0, durationMs: 3, metadata: {
      result: { plan: { metadata: { llmUsed: true } }, applied: false },
      executionOwner: 'project-runtime', projectId: 'prj_fixture', executionMode: 'worker-pool',
    } };
    const execute = vi.fn(async function* () { yield event; });
    const executeProject = vi.fn(async function* () { yield event; });
    const client = { execute, executeProject, cancel: vi.fn(), subscribe: vi.fn(), ping: vi.fn(), close: vi.fn() } as unknown as IGatewayClient;
    const written: unknown[] = [];
    const manifestCmd = {
      manifest: {
        id: '@kb-labs/fixture', group: 'fixture', segments: ['commit', 'preview'],
        v3Manifest: { id: '@kb-labs/fixture', cli: { commands: [{ path: 'commit preview', handler: './dist/run.js' }] } },
      },
    } as never;

    const exitCode = await executeViaGateway(client, {
      commandId: 'commit:preview', projectId: 'prj_fixture', argv: ['--dry-run'], flags: { 'dry-run': true },
      manifestCmd, resultWriter: (value) => written.push(value),
    });

    expect(exitCode).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(executeProject).toHaveBeenCalledWith('prj_fixture', {
      pluginId: '@kb-labs/fixture', commandPath: 'commit preview', input: { argv: ['--dry-run'], flags: { 'dry-run': true } },
    });
    expect(written).toEqual([{
      ok: true, data: { plan: { metadata: { llmUsed: true } }, applied: false },
      meta: { execution: { owner: 'project-runtime', projectId: 'prj_fixture', mode: 'worker-pool' } },
    }]);
    expect(render).toHaveBeenCalled();
    expect(finish).toHaveBeenCalled();
  });
});
