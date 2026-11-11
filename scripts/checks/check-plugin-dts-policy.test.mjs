import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
import { runExternalCheck } from './lib/run-external-check.mjs';

test('review and site-tools keep the plugin DTS policy from the node preset', () => {
  for (const packagePath of ['plugins/review', 'plugins/site-tools']) {
    const packageRoot = path.join(workspaceRoot, packagePath);
    const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const result = runExternalCheck('scripts/checks/check-plugin-dts-policy.mjs', [], {
      cwd: workspaceRoot,
      input: JSON.stringify({
        check: 'plugin-dts-policy',
        workspaceRoot,
        package: { Name: packageJson.name, Dir: packageRoot, RelPath: packagePath, Category: 'plugin-entry' },
      }),
      encoding: 'utf8',
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const { issues } = result.result;
    assert.deepEqual(issues, [], `${packageJson.name} config should preserve dependency declarations`);
  }
});
