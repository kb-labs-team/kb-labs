import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { ILogger } from '@kb-labs/core-platform';
import type { RegistryService } from '@kb-labs/marketplace-registry-core';
import { createRegistryServer } from '../server.js';

describe('S-252.2 — Registry request log credential redaction', () => {
  let server: Awaited<ReturnType<typeof createRegistryServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  // case: S-252.2
  it('redacts share tokens in Registry logs and leaves the route query intact', async () => {
    const logged: unknown[] = [];
    const write = (...args: unknown[]) => { logged.push(args); };
    const logger = {
      trace: write, debug: write, info: write, warn: write, error: write, fatal: write,
      flush: vi.fn().mockResolvedValue(undefined), child: vi.fn(),
    } as unknown as ILogger;
    const fakeToken = 'share-token-registry-test-only';
    const resolveShareToken = vi.fn().mockResolvedValue({ packageKey: 'owner/plugin' });
    const resolveIdentity = vi.fn().mockResolvedValue({
      status: 'found',
      package: { signatureSubject: 'owner/plugin', version: '1.2.3' },
    });
    const registry = {
      resolveIdentity,
      getEntry: vi.fn().mockResolvedValue({ visibility: 'private' }),
      resolveShareToken,
      canAccess: vi.fn().mockReturnValue(true),
      getVisibleEntry: vi.fn().mockReturnValue({ name: 'plugin', version: '1.2.3' }),
    } as unknown as RegistryService;

    server = await createRegistryServer({ logger, registry, internalSecret: 'registry-log-test-secret' });
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/packages/owner/plugin?token=${fakeToken}&version=1.2.3`,
      headers: { 'x-internal-secret': 'registry-log-test-secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(resolveShareToken).toHaveBeenCalledWith(fakeToken);

    const address = new URL(await server.listen({ port: 0, host: '127.0.0.1' }));
    const rawHashQueryResponse = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
      const request = httpRequest({
        hostname: address.hostname,
        port: Number(address.port),
        method: 'GET',
        path: `/api/v1/resolve#identity=widget&token=${fakeToken}&version=1.2.3`,
        headers: { 'x-internal-secret': 'registry-log-test-secret' },
      }, (incoming) => {
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk: string) => { body += chunk; });
        incoming.on('end', () => resolve({ statusCode: incoming.statusCode, body }));
      });
      request.on('error', reject);
      request.end();
    });
    expect(rawHashQueryResponse.statusCode).toBe(200);
    expect(JSON.parse(rawHashQueryResponse.body)).toMatchObject({ status: 'found' });
    expect(resolveShareToken).toHaveBeenCalledTimes(2);
    expect(resolveIdentity).toHaveBeenCalledWith('widget', null, { packageKey: 'owner/plugin' }, '1.2.3');
    const serializedLogs = JSON.stringify(logged);
    expect(serializedLogs).not.toContain(fakeToken);
    expect(serializedLogs).toContain('[REDACTED]');
    expect(serializedLogs).toContain('version=1.2.3');
  });
});

describe('S-268.23 — Registry health access for Gateway probes', () => {
  it('accepts the Gateway service identity while refusing anonymous direct health requests', async () => {
    const logger = {
      trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined), child: vi.fn(),
    } as unknown as ILogger;
    const registry = {} as RegistryService;
    const app = await createRegistryServer({ logger, registry, internalSecret: 'registry-health-test-secret' });
    try {
      const anonymous = await app.inject({ method: 'GET', url: '/health' });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json().error.code).toBe('KB_AUTH_REQUIRED');

      const gatewayProbe = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-internal-secret': 'registry-health-test-secret' },
      });
      expect(gatewayProbe.statusCode).toBe(200);
      expect(gatewayProbe.json()).toMatchObject({ status: 'ok', service: 'marketplace-registry' });

      const serviceIdentityOnReady = await app.inject({
        method: 'GET',
        url: '/ready',
        headers: { 'x-internal-secret': 'registry-health-test-secret' },
      });
      expect(serviceIdentityOnReady.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
