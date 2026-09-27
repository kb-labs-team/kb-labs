/**
 * @module @kb-labs/plugin-runtime/__tests__/platform-resolve
 *
 * The platform resolve hook against a real on-disk layout: a platform root with
 * the host's copy of the platform packages, and a "store" outside it holding a
 * plugin that carries its own nested `@kb-labs/*` copy. Imports go through the
 * real Node loader (ESM `import()` and CJS `require`), not through vitest's
 * module graph.
 */

import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constants, Script } from 'node:vm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  installPlatformResolveHook,
  PlatformDuplicateError,
  platformPackageOf,
  type PlatformResolveHook,
} from '../platform-resolve/index.js';

// A native import that bypasses vitest's module graph: the hook lives in the Node loader.
const nativeImport = new Script('(specifier) => import(specifier)', {
  importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
}).runInThisContext() as (specifier: string) => Promise<Record<string, unknown>>;

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A dual ESM/CJS package that reports which copy it is. */
function writePackage(root: string, name: string, copy: string): void {
  const dir = join(root, 'node_modules', ...name.split('/'));
  write(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      exports: {
        '.': { import: './index.mjs', require: './index.cjs' },
        './testing': { import: './testing.mjs', require: './testing.cjs' },
      },
    }),
  );
  write(join(dir, 'index.mjs'), `export const copy = ${JSON.stringify(copy)};\n`);
  write(join(dir, 'index.cjs'), `exports.copy = ${JSON.stringify(copy)};\n`);
  write(join(dir, 'testing.mjs'), `export const copy = ${JSON.stringify(`${copy}/testing`)};\n`);
  write(join(dir, 'testing.cjs'), `exports.copy = ${JSON.stringify(`${copy}/testing`)};\n`);
}

class RecordingLogger {
  readonly events: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
  event(level: string, event: { event: string; fields?: Record<string, unknown> }): void {
    this.events.push({ level, event: event.event, fields: event.fields });
  }
}

describe('platform resolve hook', () => {
  let sandbox: string;
  let platformRoot: string;
  let pluginDir: string;
  let hook: PlatformResolveHook | undefined;
  const logger = new RecordingLogger();

  beforeAll(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'kb-platform-resolve-')));
    platformRoot = join(sandbox, 'platform');
    write(join(platformRoot, 'package.json'), JSON.stringify({ name: 'platform', private: true }));
    writePackage(platformRoot, '@kb-labs/sdk', 'host');
    writePackage(platformRoot, '@kb-labs/core-runtime', 'host');
    writePackage(platformRoot, '@kb-labs/commit-core', 'host');

    // The store lives outside the platform root; the plugin brings nested copies.
    const entry = join(sandbox, 'store', 'entries', 'my-plugin@1.0.0');
    pluginDir = join(entry, 'node_modules', 'my-plugin');
    write(join(pluginDir, 'package.json'), JSON.stringify({ name: 'my-plugin', version: '1.0.0' }));
    writePackage(pluginDir, '@kb-labs/sdk', 'private');
    writePackage(pluginDir, '@kb-labs/core-runtime', 'private');
    writePackage(pluginDir, '@kb-labs/commit-core', 'private');
    // Only the plugin has this one; the host does not provide it.
    writePackage(pluginDir, '@kb-labs/core-only-in-plugin', 'private');

    write(
      join(pluginDir, 'handler.mjs'),
      [
        `import { copy as sdk } from '@kb-labs/sdk';`,
        `import { copy as sdkTesting } from '@kb-labs/sdk/testing';`,
        `import { copy as runtime } from '@kb-labs/core-runtime';`,
        `import { copy as own } from '@kb-labs/commit-core';`,
        `export const seen = { sdk, sdkTesting, runtime, own };`,
      ].join('\n'),
    );
    write(
      join(pluginDir, 'handler.cjs'),
      [
        `exports.seen = {`,
        `  sdk: require('@kb-labs/sdk').copy,`,
        `  sdkTesting: require('@kb-labs/sdk/testing').copy,`,
        `  runtime: require('@kb-labs/core-runtime').copy,`,
        `  own: require('@kb-labs/commit-core').copy,`,
        `};`,
      ].join('\n'),
    );
    write(join(pluginDir, 'orphan.mjs'), `export { copy } from '@kb-labs/core-only-in-plugin';\n`);
    write(join(pluginDir, 'orphan.cjs'), `exports.copy = require('@kb-labs/core-only-in-plugin').copy;\n`);
    // Without the hook this is what the plugin gets.
    write(join(pluginDir, 'plain.mjs'), `export { copy } from '@kb-labs/sdk';\n`);

    // Code inside the platform root is never rewritten.
    write(
      join(platformRoot, 'node_modules', '@kb-labs', 'core-runtime', 'nested-user.mjs'),
      `export { copy } from '@kb-labs/sdk';\n`,
    );
    writePackage(join(platformRoot, 'node_modules', '@kb-labs', 'core-runtime'), '@kb-labs/sdk', 'platform-nested');
  });

  afterEach(() => {
    hook?.deregister();
    hook = undefined;
    logger.events.length = 0;
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  // Every load runs a fresh copy of the fixture in its own directory: the ESM and
  // CJS loaders cache by file and by requiring directory, and would hide a second
  // resolution.
  let loads = 0;
  const fresh = (file: string): string => {
    const copy = join(pluginDir, 'runs', String(loads++), file);
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(join(pluginDir, file), copy);
    return copy;
  };
  const requireFresh = (file: string): { seen: Record<string, string>; copy?: string } =>
    createRequire(join(pluginDir, 'x.cjs'))(fresh(file)) as { seen: Record<string, string>; copy?: string };
  const load = (file: string) => nativeImport(pathToFileURL(fresh(file)).href);

  it('without the hook, the plugin resolves its own nested copy (the problem)', async () => {
    const plain = await load('plain.mjs');
    expect(plain.copy).toBe('private');
  });

  it('ESM: resolves platform packages to the host copy and leaves plugin packages alone', async () => {
    hook = installPlatformResolveHook({ platformRoot, logger });
    const { seen } = (await load('handler.mjs')) as { seen: Record<string, string> };
    expect(seen).toEqual({
      sdk: 'host',
      sdkTesting: 'host/testing',
      runtime: 'host',
      // Not a platform package: the plugin's own dependency stays private.
      own: 'private',
    });
  });

  it('CJS: resolves platform packages to the host copy and leaves plugin packages alone', () => {
    hook = installPlatformResolveHook({ platformRoot, logger });
    const { seen } = requireFresh('handler.cjs');
    expect(seen).toEqual({
      sdk: 'host',
      sdkTesting: 'host/testing',
      runtime: 'host',
      own: 'private',
    });
  });

  it('reports each overridden nested copy once, as a structured warning', async () => {
    hook = installPlatformResolveHook({ platformRoot, logger });
    await load('handler.mjs');
    requireFresh('handler.cjs');

    const overridden = logger.events.filter((e) => e.event === 'plugin.platform_duplicate_overridden');
    expect(overridden.every((e) => e.level === 'warn')).toBe(true);
    const packages = overridden.map((e) => e.fields?.package).sort();
    // handler.mjs and handler.cjs are different requesters: one event per requester and package.
    expect(packages).toEqual(['@kb-labs/core-runtime', '@kb-labs/core-runtime', '@kb-labs/sdk', '@kb-labs/sdk']);
    const first = overridden[0]?.fields;
    expect(first).toMatchObject({ code: 'KB_PLUGIN_PLATFORM_DUPLICATE', plugin: 'my-plugin' });
    expect(String(first?.ownCopy)).toContain(`${pluginDir}/node_modules/@kb-labs/`);
    expect(String(first?.hostCopy)).toContain(`${platformRoot}/node_modules/@kb-labs/`);
  });

  it('fails with KB_PLUGIN_PLATFORM_DUPLICATE when the host has no copy to substitute (ESM and CJS)', async () => {
    hook = installPlatformResolveHook({ platformRoot, logger });

    const esm = await load('orphan.mjs').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(esm).toBeInstanceOf(PlatformDuplicateError);

    let cjs: unknown;
    try {
      requireFresh('orphan.cjs');
    } catch (error) {
      cjs = error;
    }
    expect(cjs).toBeInstanceOf(PlatformDuplicateError);

    const error = cjs as PlatformDuplicateError;
    expect(error.code).toBe('KB_PLUGIN_PLATFORM_DUPLICATE');
    expect(error.envelope).toMatchObject({
      code: 'KB_PLUGIN_PLATFORM_DUPLICATE',
      area: 'plugin',
      retryable: false,
      details: { plugin: 'my-plugin', package: '@kb-labs/core-only-in-plugin' },
    });
    expect(error.envelope.message).toContain('my-plugin');
  });

  it('does not rewrite imports made by code inside the platform root', async () => {
    hook = installPlatformResolveHook({ platformRoot, logger });
    const nested = await nativeImport(
      pathToFileURL(join(platformRoot, 'node_modules', '@kb-labs', 'core-runtime', 'nested-user.mjs')).href,
    );
    expect(nested.copy).toBe('platform-nested');
  });

  it('is idempotent for one platform root and refuses a second one', () => {
    hook = installPlatformResolveHook({ platformRoot });
    expect(installPlatformResolveHook({ platformRoot })).toBe(hook);
    expect(() => installPlatformResolveHook({ platformRoot: sandbox })).toThrow(/one process has one platform/);
  });

  it('deregister removes the hook', async () => {
    installPlatformResolveHook({ platformRoot }).deregister();
    // A fresh file, so the ESM cache cannot answer for the earlier plain import.
    write(join(pluginDir, 'after.mjs'), `export { copy } from '@kb-labs/sdk';\n`);
    expect((await load('after.mjs')).copy).toBe('private');
  });
});

describe('platformPackageOf', () => {
  it.each([
    ['@kb-labs/sdk', '@kb-labs/sdk'],
    ['@kb-labs/sdk/testing', '@kb-labs/sdk'],
    ['@kb-labs/core-runtime', '@kb-labs/core-runtime'],
    ['@kb-labs/plugin-execution-factory', '@kb-labs/plugin-execution-factory'],
    ['@kb-labs/platform-client', '@kb-labs/platform-client'],
    ['@kb-labs/adapters-pino/sub/path', '@kb-labs/adapters-pino'],
  ])('%s is a platform package', (specifier, name) => {
    expect(platformPackageOf(specifier)).toBe(name);
  });

  it.each([
    '@kb-labs/commit-core',
    '@kb-labs/plugin-template-core',
    '@kb-labs/gateway-app',
    '@other/core-runtime',
    'zod',
    './sdk.js',
    'node:fs',
  ])('%s is not a platform package', (specifier) => {
    expect(platformPackageOf(specifier)).toBeUndefined();
  });
});
