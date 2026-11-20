import { afterEach, describe, expect, it, vi } from 'vitest';
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
    const registry = {
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
    const serializedLogs = JSON.stringify(logged);
    expect(serializedLogs).not.toContain(fakeToken);
    expect(serializedLogs).toContain('[REDACTED]');
    expect(serializedLogs).toContain('version=1.2.3');
  });
});
