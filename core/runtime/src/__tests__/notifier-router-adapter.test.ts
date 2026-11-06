import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAdapters } from '../discover-adapters.js';
import { type IEventBus, type INotifier } from '@kb-labs/core-platform';
import { ResourceBroker, InMemoryRateLimitBackend } from '@kb-labs/core-resource-broker';
import { platform } from '../container.js';

describe('notifier-router workspace adapter binding', () => {
  it('discovers the configured package and constructs its notifier through the runtime loader', async () => {
    const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
    const adapters = await discoverAdapters(workspaceRoot, {
      development: true,
      workspaceRoot,
      configuredPackages: [{ packageName: '@kb-labs/notifier-router', slot: 'notifier' }],
    });
    const adapter = adapters.get('@kb-labs/notifier-router');
    expect(adapter?.module.manifest).toMatchObject({ implements: 'INotifier', configSchema: { routing: { type: 'array' } } });
    expect(adapter).toBeDefined();

    const publish = vi.fn(async () => {});
    const eventBus: IEventBus = {
      publish,
      subscribe: () => () => {},
    };
    const factory = adapter!.module.createAdapter;
    expect(typeof factory).toBe('function');
    const createAdapter = factory as (...args: unknown[]) => unknown;
    const instance = createAdapter({ routing: [] }, {
      eventBus,
      broker: new ResourceBroker(new InMemoryRateLimitBackend()),
      logger: platform.logger,
      channels: {},
    }) as INotifier;

    await instance.notify({ severity: 'info', title: 'runtime loader test', body: 'constructed' });
    expect(publish).toHaveBeenCalledWith('notification.emitted', expect.objectContaining({
      title: 'runtime loader test',
      body: 'constructed',
      id: expect.any(String),
      emittedAt: expect.any(Number),
    }));
  });
});
