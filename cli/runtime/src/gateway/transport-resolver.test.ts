import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('resolveTransport', () => {
  const originalHome = process.env.HOME;
  const originalGatewayUrl = process.env.KB_GATEWAY_URL;
  let isolatedHome: string | undefined;

  afterEach(async () => {
    vi.resetModules();
    if (isolatedHome) await rm(isolatedHome, { recursive: true, force: true });
    isolatedHome = undefined;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalGatewayUrl === undefined) delete process.env.KB_GATEWAY_URL;
    else process.env.KB_GATEWAY_URL = originalGatewayUrl;
  });

  it('uses the Gateway selected by bootstrap instead of an ambient address', async () => {
    isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'kb-cli-gateway-transport-'));
    process.env.HOME = isolatedHome;
    process.env.KB_GATEWAY_URL = 'http://ambient-gateway.invalid';
    vi.resetModules();

    const { resolveTransport } = await import('./transport-resolver.js');
    const transport = await resolveTransport('http://selected-gateway.example:4321');

    expect(Reflect.get(transport, 'config')).toMatchObject({
      gatewayUrl: 'http://selected-gateway.example:4321',
      credentialKind: 'either',
    });
  });
});
