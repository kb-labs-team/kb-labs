import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ILogger } from '@kb-labs/core-platform';
import type { PlatformServices } from '@kb-labs/plugin-contracts';
import { createExecutionBackend, createNormalizedExecutionBackend } from '../factory.js';
import { WorkerPoolBackend } from '../backends/worker-pool/backend.js';
import type { ExecutionRequest } from '../types.js';

// Keep in-process last because its process-wide resolver hook intentionally
// lives for the lifetime of the host process.
const modes = ['subprocess', 'worker-pool', 'in-process'] as const;
let temporaryRoot: string | undefined;
const previousPlatformRoot = process.env.KB_PLATFORM_ROOT;

afterEach(async () => {
  if (temporaryRoot) { await rm(temporaryRoot, { recursive: true, force: true }); }
  temporaryRoot = undefined;
  if (previousPlatformRoot === undefined) { delete process.env.KB_PLATFORM_ROOT; }
  else { process.env.KB_PLATFORM_ROOT = previousPlatformRoot; }
});

describe.each(modes)('%s platform peer resolution', (mode) => {
  it('resolves SDK from the installed platform for an isolated Marketplace package without exposing the root in plugin env', async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), 'kb-isolated-platform-peer-'));
    const installationRoot = path.join(temporaryRoot, 'installation');
    const platformRoot = path.join(installationRoot, 'versions', '2.120.1');
    const sdkRoot = path.join(platformRoot, 'node_modules', '@kb-labs', 'sdk');
    const pluginRoot = path.join(
      installationRoot,
      'state', 'home', 'store', 'entries', '@kb-labs+fixture@1.0.0',
      'node_modules', '@kb-labs', 'fixture',
    );
    await Promise.all([
      mkdir(path.join(sdkRoot, 'dist'), { recursive: true }),
      mkdir(path.join(pluginRoot, 'dist'), { recursive: true }),
    ]);
    await writeFile(path.join(platformRoot, 'package.json'), JSON.stringify({ name: 'installed-platform', private: true }));
    await writeFile(path.join(sdkRoot, 'package.json'), JSON.stringify({
      name: '@kb-labs/sdk',
      version: '2.120.1',
      type: 'module',
      exports: { '.': './dist/index.js' },
    }));
    await writeFile(path.join(sdkRoot, 'dist', 'index.js'), 'export const platformMarker = "installed-sdk";\n');
    await writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({
      name: '@kb-labs/fixture',
      version: '1.0.0',
      type: 'module',
      peerDependencies: { '@kb-labs/sdk': 'workspace:*' },
    }));
    await writeFile(path.join(pluginRoot, 'dist', 'handler.mjs'), [
      "import { platformMarker } from '@kb-labs/sdk';",
      'export default { execute: async (context) => ({ platformMarker, sdkUrl: import.meta.resolve("@kb-labs/sdk"), processRoot: process.env.KB_PLATFORM_ROOT ?? null, pluginEnvRoot: context.runtime.env("KB_PLATFORM_ROOT") ?? null }) };',
      '',
    ].join('\n'));

    delete process.env.KB_PLATFORM_ROOT;
    const logger = {
      trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, flush: async () => {}, child() { return this; },
    } as unknown as ILogger;
    const platform = { logger, getAdapter: () => undefined } as unknown as PlatformServices;
    const backend = mode === 'worker-pool'
      ? createNormalizedExecutionBackend(new WorkerPoolBackend({
          platform,
          platformRoot,
          min: 1,
          max: 1,
          workerScript: fileURLToPath(new URL('../../dist/backends/worker-pool/worker-script.js', import.meta.url)),
        }), logger, mode)
      : createExecutionBackend({ platform, platformRoot, mode, workerPool: { min: 1, max: 1 } });

    const request: ExecutionRequest = {
      executionId: `sdk-peer-${mode}`,
      descriptor: {
        hostType: 'cli',
        pluginId: '@kb-labs/fixture',
        pluginVersion: '1.0.0',
        requestId: `sdk-peer-${mode}`,
        handlerId: 'fixture:check',
        permissions: {},
        hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
      },
      pluginRoot,
      handlerRef: './dist/handler.mjs',
      input: {},
      env: {},
      context: { commandPath: 'fixture check' },
    };

    try {
      const result = await backend.execute(request);
      expect(result.ok).toBe(true);
      if (!result.ok) { throw new Error('execution backend rejected the fixture'); }
      expect(result.data).toMatchObject({
        platformMarker: 'installed-sdk',
        sdkUrl: pathToFileURL(path.join(sdkRoot, 'dist', 'index.js')).href,
        processRoot: null,
        pluginEnvRoot: null,
      });
    } finally {
      await backend.shutdown();
    }
  }, 30_000);
});
