/**
 * @module @kb-labs/core-runtime/__tests__/notifier
 *
 * Tests for the notifier slot in PlatformContainer.
 * Covers only container wiring — adapter behaviour is tested in adapters/notifier-router.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initPlatform, resetPlatform } from '../loader.js';
import { platform } from '../container.js';
import type { INotifier } from '@kb-labs/core-platform';

function makeStubNotifier(): INotifier {
  return {
    notify: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  };
}

describe('platform notifier slot', () => {
  let platformRoot: string;
  beforeEach(async () => {
    resetPlatform();
    platformRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-notifier-platform-'));
    await mkdir(path.join(platformRoot, '.kb', 'v2'), { recursive: true });
    await writeFile(path.join(platformRoot, '.kb', 'v2', 'receipt.json'), JSON.stringify({
      id: 'test-receipt',
      installationId: 'test-installation',
      plan: {
        request: { gatewayUrl: 'http://127.0.0.1:4100' },
        serviceGraph: { platformVersion: 'test' },
      },
      verification: { hostHealthUrl: 'http://127.0.0.1:4100/health' },
    }));
  });
  afterEach(async () => {
    resetPlatform();
    await rm(platformRoot, { recursive: true, force: true });
  });

  it('is a NoOpNotifier when adapters.notifier is not configured (silent drop)', async () => {
    await initPlatform({ adapters: {} }, process.cwd(), undefined, platformRoot);
    // After the loader fallback pass the slot is filled with NoOpNotifier
    // — notifications are silently dropped, never thrown. `isReal()` is
    // false to signal "no real channel".
    expect(platform.notifier).toBeDefined();
    expect(platform.isReal('notifier')).toBe(false);
    // notify() resolves silently — no throw.
    await expect(
      platform.notifier?.notify({ severity: 'info', title: 't', body: 'b' }),
    ).resolves.toBeUndefined();
  });

  it('is accessible via platform.notifier after setAdapter', async () => {
    await initPlatform({ adapters: {} }, process.cwd(), undefined, platformRoot);
    const stub = makeStubNotifier();
    platform.setAdapter('notifier', stub);
    expect(platform.notifier).toBe(stub);
  });

  it('hasAdapter returns true after setAdapter', async () => {
    await initPlatform({ adapters: {} }, process.cwd(), undefined, platformRoot);
    platform.setAdapter('notifier', makeStubNotifier());
    expect(platform.hasAdapter('notifier')).toBe(true);
  });

  it('listAdapters includes notifier after setAdapter', async () => {
    await initPlatform({ adapters: {} }, process.cwd(), undefined, platformRoot);
    platform.setAdapter('notifier', makeStubNotifier());
    expect(platform.listAdapters()).toContain('notifier');
  });
});
