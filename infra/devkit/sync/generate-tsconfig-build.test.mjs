import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const syncCli = resolve(repoRoot, 'infra/devkit/bin/devkit-sync.mjs');
const tscCli = resolve(repoRoot, 'node_modules/typescript/bin/tsc');

test('DevKit sync writes a resolvable same-directory tsconfig extends path', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'devkit-tsconfig-build-'));
  try {
    await mkdir(resolve(root, 'src'));
    await mkdir(resolve(root, 'node_modules/@kb-labs'), { recursive: true });
    await symlink(resolve(repoRoot, 'infra/devkit'), resolve(root, 'node_modules/@kb-labs/devkit'), 'dir');
    await writeFile(resolve(root, 'tsup.config.ts'), 'export default {};\n');
    await writeFile(resolve(root, 'tsconfig.base.json'), JSON.stringify({
      compilerOptions: { target: 'ES2020', module: 'commonjs', strict: true },
    }));
    await writeFile(resolve(root, 'tsconfig.json'), JSON.stringify({ extends: '@kb-labs/devkit/tsconfig/node.json' }));
    await writeFile(resolve(root, 'src/index.ts'), 'export const value = 1;\n');

    const sync = spawnSync(process.execPath, [syncCli, '--only=__test__'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(sync.status, `${sync.stdout}\n${sync.stderr}`).toBe(0);

    const compile = spawnSync(process.execPath, [tscCli, '--project', resolve(root, 'tsconfig.build.json')], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
    const generated = JSON.parse(await readFile(resolve(root, 'tsconfig.build.json'), 'utf8'));
    expect(generated.extends).toBe('./tsconfig.base.json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
