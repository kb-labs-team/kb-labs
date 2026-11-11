import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMarketplaceEntry } from '@kb-labs/core-discovery';
import type { ILogger } from '@kb-labs/core-platform';
import { toErrorEnvelope } from '@kb-labs/core-platform';
import type { MarketplaceServiceAPI } from '@kb-labs/marketplace-contracts';
import { AdapterManifestLoadError, AdapterStrategy } from './adapter-strategy.js';

describe('AdapterStrategy', () => {
  let platformRoot: string | undefined;

  afterEach(async () => {
    if (platformRoot) {await fs.rm(platformRoot, { recursive: true, force: true });}
    platformRoot = undefined;
  });

  it('maps a failed adapter manifest load to its catalogued platform error', () => {
    const envelope = toErrorEnvelope(new AdapterManifestLoadError('/workspace/adapter', 'manifest is invalid'));

    expect(envelope).toMatchObject({
      code: 'KB_ADAPTER_MANIFEST_LOAD',
      area: 'plugin',
      message: 'The adapter manifest could not be loaded.',
      hint: 'Correct the adapter manifest, rebuild the adapter package, then run `kb marketplace plugins doctor --scope platform` to verify it.',
    });
  });

  async function writeAdapter(root: string, identity: string, role: string, requires?: string[]): Promise<void> {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: identity,
      type: 'module',
      kb: { adapter: { manifest: './manifest.mjs' } },
    }));
    await fs.writeFile(path.join(root, 'manifest.mjs'), `export const manifest = ${JSON.stringify({
      schema: 'kb.adapter/1', manifestVersion: '1.0.0', id: identity, name: identity, version: '1.0.0', type: 'core',
      implements: role, networkRequired: false, ...(requires ? { requires: { adapters: requires } } : {}),
    })};`);
  }

  function logger(): ILogger {
    return {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn(), trace: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      child: () => logger(),
    };
  }

  it('returns null for a package without adapter metadata and throws a typed error for a failed manifest', async () => {
    platformRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-marketplace-adapter-strategy-'));
    const strategy = new AdapterStrategy(logger(), platformRoot);
    const plainRoot = path.join(platformRoot, 'plain');
    await fs.mkdir(plainRoot);
    await fs.writeFile(path.join(plainRoot, 'package.json'), JSON.stringify({ name: 'plain' }));
    expect(await strategy.detectKind(plainRoot)).toBeNull();

    const brokenRoot = path.join(platformRoot, 'broken');
    await fs.mkdir(brokenRoot);
    await fs.writeFile(path.join(brokenRoot, 'package.json'), JSON.stringify({
      name: 'broken', type: 'module', kb: { adapter: { manifest: './manifest.mjs' } },
    }));
    await fs.writeFile(path.join(brokenRoot, 'manifest.mjs'), 'export const manifest = { schema: "kb.adapter/1", implements: "ICache" };');
    await expect(strategy.detectKind(brokenRoot)).rejects.toBeInstanceOf(AdapterManifestLoadError);
  });

  it('resolves required slots from installed manifests instead of guessing package names', async () => {
    platformRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-marketplace-adapter-dependency-'));
    const requiringRoot = path.join(platformRoot, 'requiring');
    const cacheRoot = path.join(platformRoot, 'node_modules', '@fixture', 'adapters-eventBus-cache');
    const busRoot = path.join(platformRoot, 'node_modules', '@fixture', 'unrelated-name');
    await writeAdapter(requiringRoot, 'requiring', 'IAnalytics', ['eventBus']);
    await writeAdapter(cacheRoot, '@fixture/adapters-eventBus-cache', 'ICache');
    await writeAdapter(busRoot, '@fixture/unrelated-name', 'IEventBus');

    const entries = [cacheRoot, busRoot].map((root, index) => ({
      ...createMarketplaceEntry({
        source: 'platform' as const,
        package: index === 0 ? '@fixture/adapters-eventBus-cache' : '@fixture/unrelated-name',
        resolvedPath: path.relative(platformRoot!, root),
        version: '1.0.0', integrity: 'sha256-test', primaryKind: 'adapter' as const, provides: ['adapter' as const],
      }),
      id: `installed-${index}`,
      scope: 'platform' as const,
    }));
    const service: MarketplaceServiceAPI = {
      async list() {return entries;},
      async getEntry() {return null;},
    };
    const log = logger();
    const strategy = new AdapterStrategy(log, platformRoot);

    await strategy.afterInstall('requiring', requiringRoot, service, { scope: 'platform' });

    expect(log.warn).not.toHaveBeenCalled();
  });
});
