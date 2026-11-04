import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { topoSortForBuild } from '../../src/core/dep-order';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// case: S-284.6
describe('topoSortForBuild', () => {
  it('builds a workspace devDependency before its consumer in a clean workspace', async () => {
    const root = join(tmpdir(), `kb-release-dep-order-${randomBytes(4).toString('hex')}`);
    roots.push(root);
    const consumerPath = join(root, 'consumer');
    const dependencyPath = join(root, 'dependency');
    await Promise.all([
      mkdir(consumerPath, { recursive: true }),
      mkdir(dependencyPath, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(consumerPath, 'package.json'), JSON.stringify({
        name: '@workspace/consumer',
        devDependencies: { '@workspace/dependency': 'workspace:*' },
      })),
      writeFile(join(dependencyPath, 'package.json'), JSON.stringify({ name: '@workspace/dependency' })),
    ]);

    const sorted = topoSortForBuild([
      { name: '@workspace/consumer', path: consumerPath },
      { name: '@workspace/dependency', path: dependencyPath },
    ]);

    expect(sorted.map((pkg) => pkg.name)).toEqual([
      '@workspace/dependency',
      '@workspace/consumer',
    ]);
  });
});

// case: S-284.6
describe('topoSortForBuild with a workspace self-reference', () => {
  it('keeps cross-package devDependency order when a package devDepends on itself', async () => {
    const root = join(tmpdir(), `kb-release-dep-order-${randomBytes(4).toString('hex')}`);
    roots.push(root);
    const consumerPath = join(root, 'consumer');
    const dependencyPath = join(root, 'dependency');
    const toolPath = join(root, 'tool');
    await Promise.all([
      mkdir(consumerPath, { recursive: true }),
      mkdir(dependencyPath, { recursive: true }),
      mkdir(toolPath, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(consumerPath, 'package.json'), JSON.stringify({
        name: '@workspace/consumer',
        devDependencies: { '@workspace/dependency': 'workspace:*' },
      })),
      writeFile(join(dependencyPath, 'package.json'), JSON.stringify({
        name: '@workspace/dependency',
        devDependencies: { '@workspace/tool': 'workspace:*' },
      })),
      writeFile(join(toolPath, 'package.json'), JSON.stringify({
        name: '@workspace/tool',
        devDependencies: { '@workspace/tool': 'workspace:*' },
      })),
    ]);

    const sorted = topoSortForBuild([
      { name: '@workspace/consumer', path: consumerPath },
      { name: '@workspace/tool', path: toolPath },
      { name: '@workspace/dependency', path: dependencyPath },
    ]);

    expect(sorted.map((pkg) => pkg.name)).toEqual([
      '@workspace/tool',
      '@workspace/dependency',
      '@workspace/consumer',
    ]);
  });
});
