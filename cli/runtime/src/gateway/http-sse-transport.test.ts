import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpSseGatewayTransport } from './http-sse-transport.js';
import { AuthSessionOwner } from '@kb-labs/sdk/gateway';
import { authRequiredForGateway } from '@kb-labs/sdk/gateway';
import { ErrorEnvelopeError, createErrorEnvelope } from '@kb-labs/core-platform';

describe('HttpSseGatewayTransport credential origin', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  // case: S-203.23
  it('does not refresh or send machine credentials to another Gateway origin', async () => {
    const load = vi.spyOn(AuthSessionOwner.prototype, 'load')
      .mockRejectedValue(authRequiredForGateway('https://gateway-b.test'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const transport = new HttpSseGatewayTransport({ gatewayUrl: 'https://gateway-b.test', credentialKind: 'either' });

    const execution = (async () => {
      for await (const event of transport.execute({ pluginId: '@example/plugin', handlerRef: 'dist/index.js', input: {} })) { void event; }
    })();
    await expect(execution)
      .rejects.toMatchObject({ envelope: { code: 'KB_AUTH_REQUIRED', details: { gatewayUrl: 'https://gateway-b.test' } } });

    expect(fetch).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledWith('either', { gatewayUrl: 'https://gateway-b.test' }, { refreshExpired: true });
  });

  it('delegates failed cancel responses to the shared Gateway failure decoder', async () => {
    vi.spyOn(AuthSessionOwner.prototype, 'load').mockResolvedValue({
      kind: 'session', gatewayUrl: 'https://gateway.test', accessToken: 'session-token',
      refresh: vi.fn(), save: vi.fn(),
    });
    const failure = new ErrorEnvelopeError(createErrorEnvelope('KB_RUNTIME_COMMAND_FAILED', { templateValues: { binary: 'test-cli' } }));
    const decodeFailure = vi.spyOn(AuthSessionOwner.prototype, 'decodeFailure').mockRejectedValue(failure);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private response', { status: 503 })));
    const transport = new HttpSseGatewayTransport({ gatewayUrl: 'https://gateway.test', credentialKind: 'either' });

    await expect(transport.cancel('execution-1')).rejects.toBe(failure);
    expect(decodeFailure).toHaveBeenCalledWith(
      'Gateway cancel', expect.objectContaining({ status: 503 }), 'https://gateway.test',
    );
  });

  it('can cancel a project request before the server sends its first execution event', async () => {
    vi.spyOn(AuthSessionOwner.prototype, 'load').mockResolvedValue({
      kind: 'session', gatewayUrl: 'https://gateway.test', accessToken: 'session-token',
      refresh: vi.fn(), save: vi.fn(),
    });
    let started = false;
    let aborted = false;
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      started = true;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    }));
    const transport = new HttpSseGatewayTransport({ gatewayUrl: 'https://gateway.test', credentialKind: 'either' });
    const requestId = 'request-before-first-event';
    const iterator = transport.executeProject!('prj_fixture', {
      requestId, pluginId: '@kb-labs/fixture', commandPath: 'commit preview', input: { argv: [], flags: {} },
    })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await vi.waitFor(() => expect(started).toBe(true));
    await transport.cancel(requestId, 'user');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
    await transport.close();
  });
});

describe('HttpSseGatewayTransport project runtime execution', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('sends only the project identity and bounded command data to the authenticated project route', async () => {
    vi.spyOn(AuthSessionOwner.prototype, 'load').mockResolvedValue({
      kind: 'session', gatewayUrl: 'https://gateway.test', accessToken: 'session-token',
      refresh: vi.fn(), save: vi.fn(),
    });
    const event = { type: 'execution:done', requestId: 'req-1', executionId: 'exec-1', exitCode: 0, durationMs: 1 };
    const fetch = vi.fn().mockResolvedValue(new Response(`${JSON.stringify(event)}\n`, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }));
    vi.stubGlobal('fetch', fetch);
    const transport = new HttpSseGatewayTransport({ gatewayUrl: 'https://gateway.test', credentialKind: 'session' });
    const received: ExecutionEvent[] = [];

    const requestId = 'req-transport';
    for await (const item of transport.executeProject!('prj_fixture', {
      requestId, pluginId: '@kb-labs/fixture', commandPath: 'commit preview', input: { argv: ['--'], flags: { json: true } },
    })) { received.push(item); }

    expect(fetch).toHaveBeenCalledWith('https://gateway.test/api/v1/projects/prj_fixture/rest/commands/execute', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer session-token', Accept: 'application/x-ndjson' }),
      body: JSON.stringify({ requestId, pluginId: '@kb-labs/fixture', commandPath: 'commit preview', input: { argv: ['--'], flags: { json: true } } }),
      signal: expect.any(AbortSignal),
    }));
    expect(received).toEqual([event]);
  });

  it('maps a stopped installed Gateway to the catalogued host-unreachable error', async () => {
    vi.spyOn(AuthSessionOwner.prototype, 'load').mockResolvedValue({
      kind: 'session', gatewayUrl: 'https://gateway.test', accessToken: 'session-token',
      refresh: vi.fn(), save: vi.fn(),
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('connection refused')));
    const transport = new HttpSseGatewayTransport({ gatewayUrl: 'https://gateway.test', credentialKind: 'session' });
    const execution = (async () => {
      for await (const event of transport.executeProject!('prj_fixture', {
        requestId: 'req-host-down', pluginId: '@kb-labs/fixture', commandPath: 'commit preview', input: { argv: [], flags: {} },
      })) { void event; }
    })();
    await expect(execution).rejects.toMatchObject({ envelope: { code: 'KB_HOST_UNREACHABLE' } });
  });
  it('cancels project runtime execution by aborting the streamed project request', async () => {
    vi.spyOn(AuthSessionOwner.prototype, 'load').mockResolvedValue({
      kind: 'session', gatewayUrl: 'https://gateway.test', accessToken: 'session-token',
      refresh: vi.fn(), save: vi.fn(),
    });
    let requestSignal: AbortSignal | undefined;
    const event = { type: 'execution:output', requestId: 'req-2', executionId: 'project-exec-2', stream: 'stderr', data: 'Analyzing changes...', timestamp: Date.now() };
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
          requestSignal?.addEventListener('abort', () => controller.close(), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    vi.stubGlobal('fetch', fetch);
    const transport = new HttpSseGatewayTransport({ gatewayUrl: 'https://gateway.test', credentialKind: 'session' });
    const iterator = transport.executeProject!('prj_fixture', {
      requestId: 'req-cancel-after-event', pluginId: '@kb-labs/fixture', commandPath: 'commit preview', input: { argv: [], flags: {} },
    })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(event);

    await transport.cancel(event.executionId, 'user');
    expect(requestSignal?.aborted).toBe(true);
    await iterator.return?.();
  });

});
