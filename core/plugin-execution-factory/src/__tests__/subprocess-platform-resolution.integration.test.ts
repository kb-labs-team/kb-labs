import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubprocessRunnerAdapter } from '../adapters/subprocess-runner-adapter.js';
import { SubprocessBackend } from '../backends/subprocess.js';
import type { ExecutionRequest } from '../types.js';

describe('SubprocessBackend platform module resolution', () => {
  let temporaryRoot: string | undefined;
  let previousPlatformRoot: string | undefined;

  beforeEach(() => {
    previousPlatformRoot = process.env.KB_PLATFORM_ROOT;
    delete process.env.KB_PLATFORM_ROOT;
  });

  afterEach(async () => {
    if (previousPlatformRoot === undefined) {
      delete process.env.KB_PLATFORM_ROOT;
    } else {
      process.env.KB_PLATFORM_ROOT = previousPlatformRoot;
    }
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true });
      temporaryRoot = undefined;
    }
  });

  it('carries trusted platform root through the backend and adapter without exposing it as plugin env', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'kb-subprocess-platform-root-'));
    const platformRoot = join(temporaryRoot, 'platform');
    const pluginRoot = join(temporaryRoot, 'store', 'entries', 'plugin', 'node_modules', 'plugin');

    const writePackage = async (root: string, name: string, source: string): Promise<void> => {
      const packageDir = join(root, ...name.split('/'));
      await mkdir(packageDir, { recursive: true });
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.mjs' }));
      await writeFile(join(packageDir, 'index.mjs'), source);
    };
    await writePackage(join(platformRoot, 'node_modules'), '@kb-labs/sdk', "import { owner } from '@kb-labs/shared-command-kit'; export const ownerFromSdk = owner;");
    await writePackage(join(platformRoot, 'node_modules'), '@kb-labs/shared-command-kit', "export const owner = 'platform';");
    await writePackage(join(pluginRoot, '..'), '@kb-labs/sdk', "import { owner } from '@kb-labs/shared-command-kit'; export const ownerFromSdk = owner;");
    const handlerPath = join(pluginRoot, 'handler.mjs');
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'plugin', type: 'module' }));
    await writeFile(handlerPath, "import { ownerFromSdk } from '@kb-labs/sdk'; export default { execute: async () => `${ownerFromSdk}:${process.env.KB_PLATFORM_ROOT ?? 'hidden'}` };");

    const platform = { logger: { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return this; } } };
    const backend = new SubprocessBackend({
      platform: platform as never,
      runner: new SubprocessRunnerAdapter(),
    });
    const request: ExecutionRequest = {
      executionId: 'subprocess-platform-root-chain',
      descriptor: {
        hostType: 'cli',
        pluginId: '@kb-labs/test',
        pluginVersion: '1.0.0',
        requestId: 'subprocess-platform-root-chain',
        handlerId: 'test:command',
        permissions: {},
        hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
      },
      pluginRoot,
      handlerRef: 'handler.mjs',
      input: {},
      platformRoot,
      env: { KB_PLATFORM_ROOT: join(temporaryRoot, 'attacker-controlled-root') },
      workspace: { cwd: temporaryRoot },
    };

    const result = await backend.execute(request);

    expect(result.ok).toBe(true);
    expect(result.data).toBe('platform:hidden');
  });
});
