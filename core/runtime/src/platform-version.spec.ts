import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolvePlatformVersion } from './platform-version.js';

describe('resolvePlatformVersion', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('uses the installed receipt despite a conflicting environment version', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'kb-platform-version-'));
    await mkdir(path.join(root, '.kb', 'v2'), { recursive: true });
    await writeFile(path.join(root, '.kb', 'v2', 'receipt.json'), JSON.stringify({
      plan: { serviceGraph: { platformVersion: '2.120.2-cand.d84c8f013160' } },
    }));
    const previous = process.env.KB_LABS_VERSION;
    process.env.KB_LABS_VERSION = '2.120.1';
    try {
      await expect(resolvePlatformVersion(root, { sameLocation: false })).resolves.toBe('2.120.2-cand.d84c8f013160');
    } finally {
      if (previous === undefined) delete process.env.KB_LABS_VERSION;
      else process.env.KB_LABS_VERSION = previous;
    }
  });

  it('fails with the catalogued diagnostic when the installed receipt is missing', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'kb-platform-version-'));
    await expect(resolvePlatformVersion(root, { sameLocation: false })).rejects.toMatchObject({
      envelope: { code: 'KB_CLI_PLATFORM_VERSION_UNAVAILABLE' },
    });
  });

  it('reads development version from the release owner package', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'kb-platform-version-'));
    await mkdir(path.join(root, 'core', 'runtime'), { recursive: true });
    await writeFile(path.join(root, 'core', 'runtime', 'package.json'), JSON.stringify({ version: '2.120.3' }));
    await expect(resolvePlatformVersion(root, {
      sameLocation: true,
      rawConfig: { platform: { mode: 'development' } },
    })).resolves.toBe('2.120.3');
  });
});
