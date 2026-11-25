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

  // case: S-203.1
  it('routes Gateway stdout diagnostics to stderr in JSON mode', async () => {
    process.env.KB_OUTPUT_MODE = 'json';
    const output = {
      type: 'execution:output', requestId: 'req-output', executionId: 'exec-output',
      stream: 'stdout', data: 'fixture Gateway stdout diagnostic\n', timestamp: 1,
    } as const;
    const errorOutput = {
      type: 'execution:output', requestId: 'req-output', executionId: 'exec-output',
      stream: 'stderr', data: 'fixture Gateway stderr diagnostic\n', timestamp: 2,
    } as const;
    const done = {
      type: 'execution:done', requestId: 'req-output', executionId: 'exec-output',
      exitCode: 0, durationMs: 1, metadata: { result: { complete: true } },
    } as const;
    const execute = vi.fn(async function* () { yield output; yield errorOutput; yield done; });
    const client = { execute, executeProject: undefined, cancel: vi.fn(), subscribe: vi.fn(), ping: vi.fn(), close: vi.fn() } as unknown as IGatewayClient;
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const written: unknown[] = [];

    await expect(executeViaGateway(client, {
      commandId: 'fixture:run', argv: [], flags: {},
      manifestCmd: {
        manifest: {
          id: '@kb-labs/fixture', group: 'fixture', segments: ['fixture', 'run'],
          v3Manifest: { id: '@kb-labs/fixture', cli: { commands: [{ path: 'fixture run', handler: './handler.js' }] } },
        },
      } as never,
      resultWriter: (value) => written.push(value),
    })).resolves.toBe(0);

    expect(stderrWrite).toHaveBeenCalledWith('fixture Gateway stdout diagnostic\n');
    expect(stderrWrite).toHaveBeenCalledWith('fixture Gateway stderr diagnostic\n');
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(written).toEqual([{ ok: true, data: { complete: true } }]);
    expect(render).not.toHaveBeenCalledWith(output);
    expect(render).not.toHaveBeenCalledWith(errorOutput);
  });

  // case: S-160.1
  it('uses project identity and canonical command instead of sending a client handler reference', async () => {
    process.env.KB_OUTPUT_MODE = 'json';
    const output = { type: 'execution:output', requestId: 'req-1', executionId: 'exec-1', stream: 'stdout', data: 'progress spinner', timestamp: 1 };
    const event = { type: 'execution:done', requestId: 'req-1', executionId: 'exec-1', exitCode: 0, durationMs: 3, metadata: {
      result: { plan: { metadata: { llmUsed: true } }, applied: false },
      executionOwner: 'project-runtime', projectId: 'prj_fixture', executionMode: 'worker-pool',
    } };
    const execute = vi.fn(async function* () { yield event; });
    const executeProject = vi.fn(async function* () { yield output; yield event; });
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
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), pluginId: '@kb-labs/fixture', commandPath: 'commit preview', input: { argv: ['--dry-run'], flags: { 'dry-run': true } },
    });
    expect(written).toEqual([{
      ok: true, data: { plan: { metadata: { llmUsed: true } }, applied: false },
      meta: { execution: { owner: 'project-runtime', projectId: 'prj_fixture', mode: 'worker-pool' } },
    }]);
    expect(render).toHaveBeenCalledWith(event);
    expect(render).not.toHaveBeenCalledWith(output);
    expect(finish).toHaveBeenCalled();
  });

  it('cancels by request ID and exits 130 when interrupted before the first event', async () => {
    const execute = vi.fn(async function* () {});
    let rejectExecution: ((error: Error) => void) | undefined;
    const executeProject = vi.fn(async function* () {
      await new Promise<void>((_resolve, reject) => { rejectExecution = reject; });
      yield { type: 'execution:done', requestId: 'unused', executionId: 'unused', exitCode: 0, durationMs: 1 };
    });
    const cancel = vi.fn(async (requestId: string) => {
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      rejectExecution?.(new DOMException('aborted', 'AbortError'));
    });
    const client = { execute, executeProject, cancel, subscribe: vi.fn(), ping: vi.fn(), close: vi.fn() } as unknown as IGatewayClient;
    const signalListenersBefore = new Set(process.listeners('SIGINT'));
    const running = executeViaGateway(client, {
      commandId: 'commit:preview', projectId: 'prj_fixture', argv: [], flags: {},
      manifestCmd: { manifest: { id: '@kb-labs/fixture', group: 'fixture', segments: ['commit', 'preview'], v3Manifest: { id: '@kb-labs/fixture', cli: { commands: [{ path: 'commit preview', handler: './dist/run.js' }] } } } } as never,
      resultWriter: vi.fn(),
    });
    await vi.waitFor(() => expect(rejectExecution).toBeDefined());
    const handler = process.listeners('SIGINT').find((listener) => !signalListenersBefore.has(listener));
    expect(handler).toBeDefined();
    (handler as () => void)();
    await expect(running).resolves.toBe(130);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('handles cancellation after the first output event and exits 130', async () => {
    const output = { type: 'execution:output', requestId: 'req-active', executionId: 'project-exec-active', stream: 'stderr', data: 'Generating…', timestamp: 1 };
    let rejectExecution: ((error: Error) => void) | undefined;
    const executeProject = vi.fn(async function* () {
      yield output;
      await new Promise<void>((_resolve, reject) => { rejectExecution = reject; });
    });
    const cancel = vi.fn(async (executionId: string) => {
      expect(executionId).toBe('project-exec-active');
      rejectExecution?.(new DOMException('aborted', 'AbortError'));
    });
    const client = { execute: vi.fn(async function* () {}), executeProject, cancel, subscribe: vi.fn(), ping: vi.fn(), close: vi.fn() } as unknown as IGatewayClient;
    const listenersBefore = new Set(process.listeners('SIGINT'));
    const running = executeViaGateway(client, {
      commandId: 'commit:preview', projectId: 'prj_fixture', argv: [], flags: {},
      manifestCmd: { manifest: { id: '@kb-labs/fixture', group: 'fixture', segments: ['commit', 'preview'], v3Manifest: { id: '@kb-labs/fixture', cli: { commands: [{ path: 'commit preview', handler: './dist/run.js' }] } } } } as never,
      resultWriter: vi.fn(),
    });
    await vi.waitFor(() => expect(rejectExecution).toBeDefined());
    const handler = process.listeners('SIGINT').find((listener) => !listenersBefore.has(listener));
    expect(handler).toBeDefined();
    (handler as () => void)();
    await expect(running).resolves.toBe(130);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
