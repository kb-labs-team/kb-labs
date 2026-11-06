import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { toErrorEnvelope, ErrorEnvelopeError } from './error-envelope/index.js';
import {
  GATEWAY_SERVICE_NETWORK,
  resolveGatewayServiceAddress,
  resolveCliGatewayAddress,
  resolveCliGatewayTarget,
  resolveServiceListenAddress,
} from './service-listen-address.js';

describe('resolveServiceListenAddress', () => {
  it('uses the active root receipt address and verifies its installation identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kb-gateway-target-'));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { installationId: 'root-b' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await mkdir(path.join(root, '.kb', 'v2'), { recursive: true });
      await writeFile(path.join(root, '.kb', 'v2', 'receipt.json'), JSON.stringify({
        installationId: 'root-b', verification: { hostHealthUrl: 'http://127.0.0.1:4250/health' },
      }));
      const target = await resolveCliGatewayTarget(root, { netOffset: 0 });
      expect(target).toEqual({ gatewayUrl: 'http://127.0.0.1:4250', platformRoot: root, installationId: 'root-b' });
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4250/health/identity', {
        signal: expect.any(AbortSignal),
      });
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the explicit command Gateway URL ahead of the active root receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kb-gateway-target-'));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { installationId: 'root-b' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await mkdir(path.join(root, '.kb', 'v2'), { recursive: true });
      await writeFile(path.join(root, '.kb', 'v2', 'receipt.json'), JSON.stringify({
        installationId: 'root-b', verification: { hostHealthUrl: 'http://127.0.0.1:4250/health' },
      }));
      const target = await resolveCliGatewayTarget(root, { gatewayUrl: 'http://127.0.0.1:4300', gatewayPort: '4301', netOffset: 20 });
      expect(target.gatewayUrl).toBe('http://127.0.0.1:4300');
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('honors an explicit Gateway URL without reading an invalid installed receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kb-gateway-target-'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await mkdir(path.join(root, '.kb', 'v2'), { recursive: true });
      await writeFile(path.join(root, '.kb', 'v2', 'receipt.json'), '{invalid json');

      await expect(resolveCliGatewayAddress(root, { gatewayUrl: 'http://gateway.example:4300', gatewayPort: '4301', netOffset: 0 }))
        .resolves.toEqual({ gatewayUrl: 'http://gateway.example:4300', platformRoot: root });
      await expect(resolveCliGatewayTarget(root, { gatewayUrl: 'http://gateway.example:4300', gatewayPort: '4301', netOffset: 0 }))
        .resolves.toEqual({ gatewayUrl: 'http://gateway.example:4300', platformRoot: root });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an invalid configured port even when an explicit Gateway URL wins selection', () => {
    let failure: unknown;
    try {
      resolveGatewayServiceAddress(undefined, {
        gatewayUrl: 'http://gateway.example:4300', gatewayPort: '4000oops', netOffset: 0,
      });
    } catch (error) {
      failure = error;
    }
    expect(toErrorEnvelope(failure)).toMatchObject({
      code: 'KB_CONFIG_INVALID',
      details: { path: 'GATEWAY_PORT' },
    });
  });

  it('rejects an invalid configured port even when an installed receipt wins selection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kb-gateway-target-'));
    try {
      await mkdir(path.join(root, '.kb', 'v2'), { recursive: true });
      await writeFile(path.join(root, '.kb', 'v2', 'receipt.json'), JSON.stringify({
        installationId: 'root-b', verification: { hostHealthUrl: 'http://127.0.0.1:4250/health' },
      }));

      let failure: unknown;
      try {
        await resolveCliGatewayAddress(root, { gatewayPort: '4000oops', netOffset: 0 });
      } catch (error) {
        failure = error;
      }
      expect(toErrorEnvelope(failure)).toMatchObject({
        code: 'KB_CONFIG_INVALID',
        details: { path: 'GATEWAY_PORT' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps an installed root on its receipt when ambient dev network settings are set', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kb-gateway-target-'));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { installationId: 'root-b' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await mkdir(path.join(root, '.kb', 'v2'), { recursive: true });
      await writeFile(path.join(root, '.kb', 'v2', 'receipt.json'), JSON.stringify({
        installationId: 'root-b', verification: { hostHealthUrl: 'http://127.0.0.1:4250/health' },
      }));
      const target = await resolveCliGatewayTarget(root, {
        gatewayPort: '4300', gatewayHost: '127.0.0.2', netOffset: 200,
      });
      expect(target.gatewayUrl).toBe('http://127.0.0.1:4250');
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4250/health/identity', {
        signal: expect.any(AbortSignal),
      });
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  // case: S-203.22
  it('rejects a Gateway that identifies as another installed root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kb-gateway-target-'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { installationId: 'root-a' } }), { status: 200 })));
    try {
      await mkdir(path.join(root, '.kb', 'v2'), { recursive: true });
      await writeFile(path.join(root, '.kb', 'v2', 'receipt.json'), JSON.stringify({
        installationId: 'root-b', verification: { hostHealthUrl: 'http://127.0.0.1:4250/health' },
      }));
      let failure: unknown;
      try {
        await resolveCliGatewayTarget(root, { netOffset: 0 });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ErrorEnvelopeError);
      const envelope = toErrorEnvelope(failure);
      expect(envelope).toMatchObject({
        code: 'KB_HOST_IDENTITY_MISMATCH',
        details: { expectedPlatformRoot: root, expectedInstallationId: 'root-b', actualInstallationId: 'root-a' },
      });
      expect(envelope.details).not.toHaveProperty('actualPlatformRoot');
      expect(JSON.stringify(envelope)).not.toContain('/platform-a');
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports the active root start command when its receipt address is unreachable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kb-gateway-target-'));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('connection refused'); }));
    try {
      await mkdir(path.join(root, '.kb', 'v2'), { recursive: true });
      await writeFile(path.join(root, '.kb', 'v2', 'receipt.json'), JSON.stringify({
        installationId: 'root-b', verification: { hostHealthUrl: 'http://127.0.0.1:4250/health' },
      }));
      let failure: unknown;
      try {
        await resolveCliGatewayTarget(root, { netOffset: 0 });
      } catch (error) {
        failure = error;
      }
      expect(toErrorEnvelope(failure)).toMatchObject({
        code: 'KB_HOST_UNREACHABLE',
        hint: `Run "kb-create start --platform-root ${root}" and retry the command.`,
      });
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects receipts without a stable installation ID', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kb-gateway-target-'));
    try {
      await mkdir(path.join(root, '.kb', 'v2'), { recursive: true });
      await writeFile(path.join(root, '.kb', 'v2', 'receipt.json'), JSON.stringify({
        id: 'transaction-receipt-id', verification: { hostHealthUrl: 'http://127.0.0.1:4250/health' },
      }));
      let failure: unknown;
      try {
        await resolveCliGatewayTarget(root, { netOffset: 0 });
      } catch (error) {
        failure = error;
      }
      expect(toErrorEnvelope(failure)).toMatchObject({
        code: 'KB_INSTALL_RECEIPT_UNAVAILABLE',
        hint: expect.stringContaining('kb-create update --platform-root'),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses service defaults when the active root has no receipt state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kb-gateway-target-'));
    try {
      await expect(resolveCliGatewayTarget(root, { netOffset: 0 })).resolves.toMatchObject({
        gatewayUrl: 'http://127.0.0.1:4000', platformRoot: root,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the configured transport address for a root without an installation receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kb-client-gateway-'));
    try {
      await expect(resolveCliGatewayTarget(root, {
        netOffset: 0,
        gatewayPort: '4300',
      })).resolves.toMatchObject({ gatewayUrl: 'http://127.0.0.1:4300' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies the configured Gateway port without a caller network offset', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kb-workspace-gateway-'));
    try {
      await expect(resolveCliGatewayTarget(root, { gatewayPort: '4300', netOffset: 0 })).resolves.toMatchObject({
        gatewayUrl: 'http://127.0.0.1:4300', platformRoot: root,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exports the gateway service network settings shared by all address consumers', () => {
    expect(GATEWAY_SERVICE_NETWORK).toEqual({
      serviceId: 'gateway',
      portEnvVar: 'GATEWAY_PORT',
      defaultPort: 4000,
      hostEnvVar: 'GATEWAY_HOST',
      defaultHost: '0.0.0.0',
    });
  });

  it('resolves the gateway URL from the host override before listener settings', () => {
    expect(resolveGatewayServiceAddress(undefined, {
      gatewayUrl: 'https://gateway.example.test/',
      netOffset: 500,
    })).toBe('https://gateway.example.test');
  });

  it('uses the same transport, GATEWAY_PORT, and offset rules as plugin Gateway calls', () => {
    expect(resolveGatewayServiceAddress(undefined, {
      gatewayPort: '4300',
      netOffset: 200,
    })).toBe('http://127.0.0.1:4500');
    expect(resolveGatewayServiceAddress({
      listenAddress: () => ({ host: '0.0.0.0', port: 43323 }),
    }, {
      gatewayPort: '4300',
      netOffset: 200,
    })).toBe('http://127.0.0.1:43323');
  });

  it('surfaces invalid GATEWAY_PORT as the catalogued configuration error', () => {
    let failure: unknown;
    try {
      resolveGatewayServiceAddress(undefined, { gatewayPort: '4000oops', netOffset: 0 });
    } catch (error) {
      failure = error;
    }
    expect(toErrorEnvelope(failure)).toMatchObject({ code: 'KB_CONFIG_INVALID' });
  });

  // case: S-010.7
  it('uses the service transport listen address without applying the offset twice', () => {
    expect(resolveServiceListenAddress({
      listenAddress: () => ({ host: '10.0.0.8', port: 43323 }),
    }, {
      serviceId: 'gateway',
      defaultHost: '0.0.0.0',
      defaultPort: 4000,
    }, 200)).toEqual({ host: '10.0.0.8', port: 43323 });
  });

  // case: S-203.15
  it('uses the module default and offset when a fresh install has no transport address or gateway.port', () => {
    expect(resolveServiceListenAddress(undefined, {
      serviceId: 'gateway',
      defaultHost: '0.0.0.0',
      defaultPort: 4000,
    }, 200)).toEqual({ host: '0.0.0.0', port: 4200 });
  });

  it('uses the module port environment value and offset when transport has no TCP address', () => {
    expect(resolveServiceListenAddress({
      listenAddress: () => ({ socketPath: '/tmp/gateway.sock' }),
    }, {
      serviceId: 'gateway',
      portEnvValue: '4500',
      defaultPort: 4000,
      hostEnvValue: '127.0.0.1',
      defaultHost: '0.0.0.0',
    }, 200)).toEqual({ host: '127.0.0.1', port: 4700 });
  });

  // case: S-203.16
  it('rejects malformed and out-of-range GATEWAY_PORT values with a catalogued config error', () => {
    for (const value of ['4000oops', '4000.5', '0', '65536', '-1']) {
      let failure: unknown;
      try {
        resolveServiceListenAddress(undefined, {
          serviceId: GATEWAY_SERVICE_NETWORK.serviceId,
          portEnvVar: GATEWAY_SERVICE_NETWORK.portEnvVar,
          portEnvValue: value,
          defaultPort: GATEWAY_SERVICE_NETWORK.defaultPort,
        }, 0);
      } catch (error) {
        failure = error;
      }

      expect(toErrorEnvelope(failure)).toMatchObject({
        code: 'KB_CONFIG_INVALID',
        message: expect.stringContaining('GATEWAY_PORT'),
        hint: 'Run "unset GATEWAY_PORT", then retry the command to use the service default port.',
      });
    }
  });

  // case: S-203.16
  it('rejects an offset that would put the resolved listener outside the valid port range', () => {
    let failure: unknown;
    try {
      resolveServiceListenAddress(undefined, {
        serviceId: 'gateway',
        portEnvVar: 'GATEWAY_PORT',
        portEnvValue: '65530',
        defaultPort: 4000,
      }, 10);
    } catch (error) {
      failure = error;
    }

    expect(toErrorEnvelope(failure)).toMatchObject({
      code: 'KB_CONFIG_INVALID',
      message: expect.stringContaining('GATEWAY_PORT'),
    });
  });
});
