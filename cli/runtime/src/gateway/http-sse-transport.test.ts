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
});
