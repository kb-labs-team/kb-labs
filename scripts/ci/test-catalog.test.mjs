import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('test catalog classifies ordinary specs by location and keeps E2E specs', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/test-catalog.mjs'), '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const { catalog } = JSON.parse(result.stdout);

  assert.ok(catalog['@kb-labs/core-config'].unit['core/config/src/__tests__/cache.spec.ts']);
  assert.ok(catalog['@kb-labs/core-runtime'].integration[
    'core/runtime/src/__tests__/unexpected-error-persistence.integration.spec.ts'
  ]);
  assert.ok(catalog['@kb-labs/shared-testing-e2e'].unit[
    'shared/testing-e2e/src/__tests__/diag-collector.test.ts'
  ]);
  assert.ok(catalog['@kb-labs/scaffold-core'].e2e['cli/scaffold/core/tests/engine.e2e.test.ts']);
  assert.ok(catalog['@kb-labs/e2e-gateway'].e2e[
    'e2e/gateway/scenarios/default/cases/auth.spec.ts'
  ]);
});
