import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSourceStorageRoot, resolveInside, resolveSourceRoot } from '../../src/core/index.js';

const temporaryRoots: string[] = [];

async function createTempDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viewer-core-test-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('viewer source paths', () => {
  // case: S-205.6
  it('rejects traversal and symlinks that point outside the selected source', async () => {
    const project = await createTempDirectory();
    const root = path.join(project, 'docs', 'architecture');
    const outside = path.join(project, 'secret.txt');
    await mkdir(root, { recursive: true });
    await writeFile(outside, 'secret');
    await symlink(outside, path.join(root, 'escape.txt'));

    await expect(resolveInside(root, '../secret.txt')).rejects.toMatchObject({ code: 'KB_RUNTIME_INPUT_INVALID' });
    await expect(resolveInside(root, 'escape.txt')).rejects.toMatchObject({ code: 'KB_RUNTIME_INPUT_INVALID' });
  });

  // case: S-205.7
  it('rejects managed source storage redirected outside the project', async () => {
    const project = await createTempDirectory();
    const outside = await createTempDirectory();
    await symlink(outside, path.join(project, '.kb'));

    await expect(ensureSourceStorageRoot(project)).rejects.toThrow('Viewer storage must be inside the project');
  });

  // case: S-205.6
  it('resolves imported sources only from the project managed directory', async () => {
    const project = await createTempDirectory();
    const outside = await createTempDirectory();
    const sourcesPath = path.join(project, '.kb', 'viewer', 'sources');
    await mkdir(path.dirname(sourcesPath), { recursive: true });
    await symlink(outside, sourcesPath);
    const id = 'pkg-12345678';

    await expect(resolveSourceRoot(project, id)).rejects.toThrow();
    expect(await realpath(outside)).not.toBe(project);
  });
});
