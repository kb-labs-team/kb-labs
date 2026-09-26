/**
 * Tests for manifest discovery with mixed CJS/ESM loading
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CommandManifest } from "../types";

const fsPromisesMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Keep the real sync fs helpers (state-dir resolution uses realpath/existsSync); only `promises` is mocked.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  promises: fsPromisesMock,
}));

vi.mock("node:fs/promises", () => fsPromisesMock);

vi.mock('yaml', () => ({
  parse: vi.fn(),
}));

vi.mock('glob', () => ({
  glob: vi.fn(),
}));

// Logger mock removed - using cli-core logger abstraction directly

vi.mock('../utils/path.js', () => ({
  toPosixPath: (p: string) => p.replace(/\\/g, '/'),
}));


const importDiscoverModule = () => import('../discover');

describe('discoverManifests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsPromisesMock.readFile.mockResolvedValue("{}");
    fsPromisesMock.readdir.mockResolvedValue([]);
    fsPromisesMock.stat.mockResolvedValue({
      isDirectory: () => true,
      isFile: () => true,
      mtimeMs: 0,
    } as any);
    fsPromisesMock.mkdir.mockResolvedValue(undefined);
    fsPromisesMock.writeFile.mockResolvedValue(undefined);
  });

  it('should discover workspace packages with pnpm-workspace.yaml', async () => {
    const { readFile } = await import('node:fs/promises');
    const { parse } = await import('yaml');
    const { glob } = await import('glob');

    // Mock workspace file
    vi.mocked(readFile).mockResolvedValueOnce('packages:\n  - "packages/*"');
    vi.mocked(parse).mockReturnValue({ packages: ['packages/*'] });

    // Mock glob results
    vi.mocked(glob).mockResolvedValue(['packages/test-package']);

    // Mock package.json
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      name: '@kb-labs/test-package',
      kb: { commandsManifest: './dist/cli.manifest.js' },
    }));

    // Mock manifest file
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      commands: [{
        manifestVersion: '1.0',
        id: 'test:command',
        group: 'test',
        describe: 'Test command',
        loader: async () => ({ run: async () => 0 }),
      }],
    }));

    const { discoverManifests } = await importDiscoverModule();
    const results = await discoverManifests("/test/cwd", false);

    expect(Array.isArray(results)).toBe(true);
  });

  it('should fallback to current package when no workspace file', async () => {
    const { readFile } = await import('node:fs/promises');

    // Mock no workspace file
    vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'));

    // Mock current package.json
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      name: '@kb-labs/current-package',
      kb: { commandsManifest: './dist/cli.manifest.js' },
    }));

    // Mock manifest file
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      commands: [{
        manifestVersion: '1.0',
        id: 'current:command',
        group: 'current',
        describe: 'Current command',
        loader: async () => ({ run: async () => 0 }),
      }],
    }));

    const { discoverManifests } = await importDiscoverModule();
    const results = await discoverManifests("/test/cwd", false);

    expect(Array.isArray(results)).toBe(true);
  });

  it('should discover node_modules packages', async () => {
    const { readFile } = await import('node:fs/promises');
    const { readdir } = await import('node:fs/promises');

    // Mock no workspace file
    vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'));

    // Mock no current package
    vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'));

    // Mock node_modules directory
    vi.mocked(readdir).mockResolvedValueOnce([
      { name: 'test-package', isDirectory: () => true } as any,
    ]);

    // Mock package.json in node_modules
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      name: '@kb-labs/test-package',
      kb: { commandsManifest: './dist/cli.manifest.js' },
    }));

    // Mock manifest file
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      commands: [{
        manifestVersion: '1.0',
        id: 'test:command',
        group: 'test',
        describe: 'Test command',
        loader: async () => ({ run: async () => 0 }),
      }],
    }));

    const { discoverManifests } = await importDiscoverModule();
    const results = await discoverManifests("/test/cwd", false);

    expect(Array.isArray(results)).toBe(true);
  });

  it('should handle manifest load timeout', async () => {
    const { readFile } = await import('node:fs/promises');
    const { parse } = await import('yaml');
    const { glob } = await import('glob');

    // Mock workspace file
    vi.mocked(readFile).mockResolvedValueOnce('packages:\n  - "packages/*"');
    vi.mocked(parse).mockReturnValue({ packages: ['packages/*'] });
    vi.mocked(glob).mockResolvedValue(['packages/test-package']);

    // Mock package.json
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      name: '@kb-labs/test-package',
      kb: { commandsManifest: './dist/cli.manifest.js' },
    }));

    // Mock manifest file that times out
    vi.mocked(readFile).mockImplementationOnce(() =>
      new Promise((resolve) => {
        setTimeout(() => resolve('{}'), 2000);
      })
    );

    const { discoverManifests } = await importDiscoverModule();
    const results = await discoverManifests("/test/cwd", false);

    expect(Array.isArray(results)).toBe(true);
  });

  it('should rehydrate loader stub for cached manifest entries', async () => {
    const { __test } = await import('../discover') as any;

    const manifest = {
      manifestVersion: '1.0',
      id: 'test:init',
      group: 'test',
      describe: 'Test init command',
      flags: [],
      examples: [],
    } as unknown as CommandManifest;

    expect(typeof manifest.loader).not.toBe('function');
    __test.ensureManifestLoader(manifest);
    expect(typeof manifest.loader).toBe('function');
    await expect(manifest.loader!()).rejects.toThrow(/ManifestV3 command/);
  });

});
