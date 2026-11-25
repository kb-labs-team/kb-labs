import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileSystemArtifactClient } from './fs-client.js';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'workflow-artifact-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileSystemArtifactClient.produceAtomic', () => {
  it('writes binary and large streams atomically with private file permissions', async () => {
    const root = await makeRoot();
    const client = createFileSystemArtifactClient(root);
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.alloc(1_100_000, 0x61)]);

    await client.produceAtomic('runs/run-1/workspace.patch', Readable.from([bytes.subarray(0, 100), bytes.subarray(100)]));

    expect(await readFile(path.join(root, 'runs/run-1/workspace.patch'))).toEqual(bytes);
    expect((await stat(path.join(root, 'runs/run-1/workspace.patch'))).mode & 0o777).toBe(0o600);
  });

  it('leaves no final or temporary artifact when the source stream fails', async () => {
    const root = await makeRoot();
    const client = createFileSystemArtifactClient(root);
    await client.produce('runs/run-2/workspace.patch', 'previous complete artifact');
    const source = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('source failed'));
      },
    });

    await expect(client.produceAtomic('runs/run-2/workspace.patch', source)).rejects.toThrow('source failed');
    await expect(readFile(path.join(root, 'runs/run-2/workspace.patch'), 'utf8')).resolves.toBe('previous complete artifact');
    await expect(readdir(path.join(root, 'runs/run-2'))).resolves.toEqual(['workspace.patch']);
  });

  it('refuses symlinked roots, parent directories, and targets without writing outside the artifact root', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const client = createFileSystemArtifactClient(root);

    await symlink(outside, path.join(root, 'linked-parent'), 'dir');
    await expect(client.produceAtomic('linked-parent/escape.patch', 'outside')).rejects.toThrow(/symbolic link/);
    await expect(readdir(outside)).resolves.toEqual([]);

    const outsideFile = path.join(outside, 'target.patch');
    await writeFile(outsideFile, 'keep');
    await symlink(outsideFile, path.join(root, 'target.patch'));
    await expect(client.produceAtomic('target.patch', 'overwrite')).rejects.toThrow(/regular file/);
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('keep');

    const rootLink = path.join(root, 'root-link');
    await symlink(outside, rootLink, 'dir');
    await expect(createFileSystemArtifactClient(rootLink).produceAtomic('escape.patch', 'outside')).rejects.toThrow(/root/);
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('keep');
    await expect(readdir(root)).resolves.toContain('target.patch');
  });

  it('refuses a symlinked parent between the trusted project root and artifact root', async () => {
    const projectRoot = await makeRoot();
    const outside = await makeRoot();
    await symlink(outside, path.join(projectRoot, '.kb'), 'dir');
    const client = createFileSystemArtifactClient(path.join(projectRoot, '.kb/run-artifacts'), { trustedRoot: projectRoot });

    await expect(client.produceAtomic('workflow-runs/run/patch', 'secret')).rejects.toThrow(/symbolic link/);
    await expect(readdir(outside)).resolves.toEqual([]);
  });
});
