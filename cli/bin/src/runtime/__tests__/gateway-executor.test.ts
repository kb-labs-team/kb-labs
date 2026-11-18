import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProductErrorEnvelope } from '@kb-labs/core-platform';
import type { RegisteredCommand } from '@kb-labs/cli-commands';
import type { IGatewayClient } from '@kb-labs/sdk/gateway';
import { executeViaGateway } from '../gateway-executor.js';

const manifestCmd = {
  manifest: {
    id: '@fixture/plugin',
    segments: ['fixture', 'run'],
    v3Manifest: {
      id: '@fixture/plugin',
      cli: { commands: [{ path: 'fixture run', handler: './handler.js#default' }] },
    },
  },
} as unknown as RegisteredCommand;

function clientFor(events: unknown[]) {
  const execute = vi.fn(async function* (_request: unknown) {
    for (const event of events) {yield event;}
  });
  const close = vi.fn(async () => {});
  return { client: { execute, close, cancel: vi.fn() } as unknown as IGatewayClient, execute, close };
}

describe('explicit Gateway execution transport', () => {
  afterEach(() => {vi.unstubAllEnvs(); vi.restoreAllMocks();});

  // case: S-203.1
  it('writes a successful remote result exactly once', async () => {
    vi.stubEnv('KB_OUTPUT_MODE', 'json');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { client, execute, close } = clientFor([
      { type: 'execution:output', requestId: 'req', executionId: 'exec',
        stream: 'stdout', data: 'remote diagnostic\n', timestamp: Date.now() },
      { type: 'execution:done', requestId: 'req', executionId: 'exec',
        exitCode: 0, durationMs: 1, metadata: { result: { remote: true } } },
    ]);
    const results: unknown[] = [];

    const code = await executeViaGateway(client, {
      commandId: 'fixture:run', argv: [], flags: {}, manifestCmd,
      resultWriter: (result) => {results.push(result);},
    });

    expect(code).toBe(0);
    expect(results).toEqual([{ ok: true, data: { remote: true } }]);
    expect(output).toHaveBeenCalledWith('remote diagnostic\n');
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ pluginId: '@fixture/plugin', handlerRef: './handler.js' });
    expect(close).toHaveBeenCalledOnce();
  });

  // case: S-203.1
  it('writes a remote error envelope exactly once', async () => {
    vi.stubEnv('KB_OUTPUT_MODE', 'json');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const error = createProductErrorEnvelope({
      code: 'FIXTURE_FAILED', message: 'Fixture Gateway failure', hint: 'Retry the command.', retryable: false,
    });
    const { client, close } = clientFor([
      { type: 'execution:error', requestId: 'req', executionId: 'exec', error },
      { type: 'execution:done', requestId: 'req', executionId: 'exec', exitCode: 1, durationMs: 1 },
    ]);
    const results: unknown[] = [];

    const code = await executeViaGateway(client, {
      commandId: 'fixture:run', argv: [], flags: {}, manifestCmd,
      resultWriter: (result) => {results.push(result);},
    });

    expect(code).toBe(1);
    expect(results).toEqual([{ ok: false, error }]);
    expect(close).toHaveBeenCalledOnce();
  });
});
