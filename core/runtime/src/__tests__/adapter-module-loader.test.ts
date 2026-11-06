import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configuredAdapterLoadError, configuredWorkspaceAdapterNotBuiltError, loadDiscoveredAdapterModule, loadWorkspaceAdapterModule } from '../adapter-module-loader.js';
import { AdapterUnavailableError } from '@kb-labs/core-platform';
import type { DiscoveredAdapter } from '../discover-adapters.js';

describe('loadDiscoveredAdapterModule', () => {
  // case: S-054.2
  it('preserves a dependent package error and directs the user to host diagnostics', () => {
    const cause = Object.assign(new Error("Cannot find package 'openai' imported from /platform/node_modules/@kb-labs/adapters-openai/dist/llm.js"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const error = configuredAdapterLoadError('llm', '@kb-labs/adapters-openai', cause, '/platform');

    expect(error).toBeInstanceOf(AdapterUnavailableError);
    expect(error.slot).toBe('llm');
    expect(error.reason).toBe('load-failed');
    expect(error.message).toContain('package "@kb-labs/adapters-openai"');
    expect(error.message).toContain('ERR_MODULE_NOT_FOUND');
    expect(error.message).toContain("Cannot find package 'openai'");
    expect(error.message).not.toContain('kb marketplace install');
    expect(error.message).toContain('kb-create doctor --platform-root "/platform"');
    expect(error.action?.command).toBe('kb-create doctor --platform-root "/platform"');
    expect(error.cause).toBe(cause);
  });

  // case: S-054.2
  it('suggests installation only when the configured package itself is missing', () => {
    const cause = Object.assign(new Error("Cannot find package '@kb-labs/adapters-openai' imported from /platform/host.js"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const error = configuredAdapterLoadError('llm', '@kb-labs/adapters-openai', cause, '/platform');

    expect(error.message).toContain('kb marketplace install @kb-labs/adapters-openai --scope platform');
    expect(error.message).toContain('Install it with `kb marketplace install @kb-labs/adapters-openai --scope platform`.');
    expect(error.message).toContain('ERR_MODULE_NOT_FOUND');
    expect(error.message).not.toContain('kb-create doctor');
    expect(error.action?.command).toBe('kb marketplace install @kb-labs/adapters-openai --scope platform');
    expect(error.cause).toBe(cause);
  });

  // case: S-211.6
  it('recognizes the configured package manifest ENOENT as a missing installation', () => {
    const cause = Object.assign(new Error("ENOENT: no such file or directory, open '/platform/node_modules/@kb-labs/adapters-vibeproxy/package.json'"), {
      code: 'ENOENT',
    });
    const error = configuredAdapterLoadError('llm', '@kb-labs/adapters-vibeproxy', cause, '/platform');

    expect(error.action?.command).toBe('kb marketplace install @kb-labs/adapters-vibeproxy --scope platform');
    expect(error.message).toContain('ENOENT');
  });

  // case: S-179.12
  it('gives the install command when a configured package is absent from workspace and lock discovery', () => {
    const cause = Object.assign(new Error("Cannot find package '@kb-labs/adapters-fs' imported from /platform/host.js"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const error = configuredAdapterLoadError('storage', '@kb-labs/adapters-fs', cause, '/platform');

    expect(error).toBeInstanceOf(AdapterUnavailableError);
    expect(error.message).toContain('kb marketplace install @kb-labs/adapters-fs --scope platform');
  });

  let root: string;
  let adapter: DiscoveredAdapter;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'adapter-module-loader-'));
    const dist = path.join(root, 'dist');
    await fs.mkdir(dist, { recursive: true });
    await fs.writeFile(path.join(dist, 'index.js'), `export const manifest = { schema: 'kb.adapter/1', implements: 'IDocumentDatabase' }; export function createAdapter() { return { kind: 'document' }; }`);
    await fs.writeFile(path.join(dist, 'kv.js'), `export const manifest = { schema: 'kb.adapter/1', implements: 'IKVStore' }; export function createAdapter() { return { get() { return 'kv'; } }; }`);
    const manifest: DiscoveredAdapter['module']['manifest'] = { schema: 'kb.adapter/1', manifestVersion: '1.0.0', id: 'test-sqlite', name: 'Test SQLite', version: '1.0.0', type: 'core', implements: ['IDocumentDatabase', 'IKVStore'], networkRequired: false };
    adapter = {
      packageName: '@test/sqlite', pkgRoot: root, createAdapter: () => ({}),
      module: { manifest },
      entrypointManifests: { '': manifest },
    };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('loads the requested KV subpath factory instead of the package root', async () => {
    const module = await loadDiscoveredAdapterModule(adapter, '@test/sqlite/kv');
    const store = module.createAdapter({}, {}) as { get(): string };

    expect(module.manifest.implements).toBe('IKVStore');
    expect(store.get()).toBe('kv');
  });

  it('fails when a requested subpath is missing instead of loading the root adapter', async () => {
    await expect(loadDiscoveredAdapterModule(adapter, '@test/sqlite/kv-missing'))
      .rejects.toThrow('kv-missing.js');
  });

  // case: S-179.6
  it('returns a typed build hint when the configured workspace package has no dist output', async () => {
    const unbuiltRoot = path.join(root, 'unbuilt');
    await fs.mkdir(unbuiltRoot, { recursive: true });
    const manifest: DiscoveredAdapter['module']['manifest'] = { schema: 'kb.adapter/1', manifestVersion: '1.0.0', id: 'unbuilt', name: 'Unbuilt', version: '1.0.0', type: 'core', implements: 'IStorage', networkRequired: false };
    const unbuilt: DiscoveredAdapter = {
      packageName: '@kb-labs/adapters-fs',
      pkgRoot: unbuiltRoot,
      createAdapter: () => undefined,
      module: { manifest },
      entrypointManifests: { '': manifest },
    };

    await expect(loadWorkspaceAdapterModule('storage', unbuilt, '@kb-labs/adapters-fs'))
      .rejects.toMatchObject({
        name: 'AdapterUnavailableError',
        slot: 'storage',
        reason: 'load-failed',
        message: expect.stringContaining('pnpm build'),
      });
  });
});

describe('configuredWorkspaceAdapterNotBuiltError', () => {
  // case: S-179.6
  it('returns a typed workspace build error with the exact next command', () => {
    const error = configuredWorkspaceAdapterNotBuiltError('storage', '@kb-labs/adapters-fs');

    expect(error).toBeInstanceOf(AdapterUnavailableError);
    expect(error.slot).toBe('storage');
    expect(error.reason).toBe('load-failed');
    expect(error.message).toContain('workspace adapter package "@kb-labs/adapters-fs" has not been built');
    expect(error.message).toContain('pnpm build');
    expect(error.message).not.toContain('Error:');
  });
});
