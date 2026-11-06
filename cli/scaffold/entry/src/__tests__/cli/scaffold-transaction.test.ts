import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeScaffoldTransaction } from '../../commands/scaffold-transaction.js';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kb-scaffold-transaction-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('writeScaffoldTransaction', () => {
  it('removes partially generated files when writing fails', async () => {
    const parent = await makeRoot();
    const outRoot = join(parent, 'plugin');

    await expect(writeScaffoldTransaction(
      outRoot,
      async () => { await mkdir(outRoot); await writeFile(join(outRoot, 'package.json'), '{}'); throw new Error('disk full'); },
    )).rejects.toThrow('disk full');

    await expect(readFile(outRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores previous output when forced replacement fails to write', async () => {
    const parent = await makeRoot();
    const outRoot = join(parent, 'plugin');
    await mkdir(outRoot);
    await writeFile(join(outRoot, 'previous.txt'), 'keep');

    await expect(writeScaffoldTransaction(
      outRoot,
      async () => { await mkdir(outRoot); await writeFile(join(outRoot, 'new.txt'), 'new'); throw new Error('disk full'); },
    )).rejects.toThrow('disk full');

    expect(await readFile(join(outRoot, 'previous.txt'), 'utf8')).toBe('keep');
  });
});
