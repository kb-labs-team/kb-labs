import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runExternalCheck } from '../lib/run-external-check.mjs';

const checker = fileURLToPath(new URL('../check-plugin-package-exports.mjs', import.meta.url));

test('plugin package exports are explicit and resolve into built dist output', async () => {
  const packageRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-plugin-export-check-'));
  try {
    await mkdir(path.join(packageRoot, 'dist'), { recursive: true });
    await writeFile(path.join(packageRoot, 'dist/index.js'), 'export {}\n');
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageJson = {
      name: '@fixture/plugin-entry',
      exports: {
        '.': { import: './dist/index.js' },
        './package.json': './package.json',
      },
    };
    await writeFile(packageJsonPath, JSON.stringify(packageJson));
    const input = {
      check: 'plugin-package-exports',
      workspaceRoot: packageRoot,
      package: { Dir: packageRoot },
    };

    assert.deepEqual(await runChecker(packageRoot, input), []);

    packageJson.exports['./dist/*'] = './dist/*';
    await writeFile(packageJsonPath, JSON.stringify(packageJson));
    const wildcardIssues = await runChecker(packageRoot, input);
    assert.ok(wildcardIssues.some(issue => issue.message.includes('wildcard export ./dist/*')));

    packageJson.exports = { '.': { import: './dist/index.js' } };
    await writeFile(packageJsonPath, JSON.stringify(packageJson));
    assert.deepEqual(await runChecker(packageRoot, input), []);

    packageJson.exports['./missing'] = './dist/missing.js';
    await writeFile(packageJsonPath, JSON.stringify(packageJson));
    const missingIssues = await runChecker(packageRoot, input);
    assert.ok(missingIssues.some(issue => issue.message.includes('export target ./dist/missing.js does not exist')));

    packageJson.exports = { '.': { import: './dist/index.js' } };
    await writeFile(packageJsonPath, JSON.stringify(packageJson));
    assert.deepEqual(await runChecker(packageRoot, input), []);
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

async function runChecker(packageRoot, input) {
  const result = runExternalCheck(checker, [], {
    cwd: packageRoot,
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.result.issues;
}
