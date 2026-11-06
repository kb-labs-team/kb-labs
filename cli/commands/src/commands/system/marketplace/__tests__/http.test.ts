import { afterEach, describe, expect, it, vi } from 'vitest';

const gatewayApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@kb-labs/sdk', () => ({
  useEnv: (name: string) => name === 'KB_GATEWAY_URL' ? 'http://gateway.test' : undefined,
  getHostServiceAddress: (_service: string, environment: Record<string, string | undefined>) => {
    if (!environment.KB_GATEWAY_URL) { throw new Error('gateway address missing'); }
    return environment.KB_GATEWAY_URL.replace(/\/+$/, '');
  },
}));
vi.mock('@kb-labs/sdk/gateway', async (importOriginal) => ({
  ...await importOriginal<typeof import('@kb-labs/sdk/gateway')>(),
  gatewayApiFetch,
}));

import { get } from '../http.js';

describe('marketplace shared gateway client', () => {
  afterEach(() => { gatewayApiFetch.mockReset(); });

  // case: S-041.7
  it('delegates marketplace REST calls to the shared authenticated client', async () => {
    gatewayApiFetch.mockResolvedValue(new Response(JSON.stringify({ packages: [] }), { status: 200 }));
    await expect(get('/packages')).resolves.toEqual({ packages: [] });
    expect(gatewayApiFetch).toHaveBeenCalledWith(
      new URL('http://gateway.test/api/v1/marketplace/packages'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('preserves the catalog envelope from marketplace failures', async () => {
    gatewayApiFetch.mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: { code: 'KB_PLUGIN_NOT_FOUND', message: 'Plugin was not found', hint: 'Install it with kb marketplace install <package>.' },
      internal: 'secret detail',
    }), { status: 404 }));
    await expect(get('/packages')).rejects.toMatchObject({
      message: 'Plugin was not found',
      envelope: {
        code: 'KB_PLUGIN_NOT_FOUND',
        message: 'Plugin was not found',
        hint: 'Install it with kb marketplace install <package>.',
      },
    });
  });

  it('points timeout recovery at the installed platform commands', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    gatewayApiFetch.mockRejectedValue(abort);
    await expect(get('/packages')).rejects.toThrow(
      'Marketplace /packages timed out. Check the installed platform with `kb-create status`; start it with `kb-create start` if it is stopped.',
    );
  });
});
