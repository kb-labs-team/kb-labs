import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { e2eNodeTestIssues } from './e2e-node-tests.mjs';

test('reports node:test files not covered by an e2e package test glob', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-node-tests-'));
  try {
    mkdirSync(join(root, 'e2e/package-a'), { recursive: true });
    mkdirSync(join(root, 'e2e/package-b'), { recursive: true });
    mkdirSync(join(root, 'e2e/package-a/tests'));
    mkdirSync(join(root, 'e2e/package-b/tests'));
    writeFileSync(join(root, 'e2e/package-a/package.json'), JSON.stringify({
      name: '@kb-labs/e2e-a', scripts: { test: 'node --test tests/*.test.mjs' },
    }));
    writeFileSync(join(root, 'e2e/package-a/tests/covered.test.mjs'), "import test from 'node:test'; test('covered', () => {});\n");
    writeFileSync(join(root, 'e2e/package-b/package.json'), JSON.stringify({ name: '@kb-labs/e2e-b' }));
    writeFileSync(join(root, 'e2e/package-b/tests/orphan.test.mjs'), "import test from 'node:test'; test('orphan', () => {});\n");

    const issues = await e2eNodeTestIssues(root);
    assert.deepEqual(issues.map(issue => issue.file), ['e2e/package-b/tests/orphan.test.mjs']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not classify a non-node:test source file as a test', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-node-tests-'));
  try {
    mkdirSync(join(root, 'e2e/package-a'), { recursive: true });
    writeFileSync(join(root, 'e2e/package-a/package.json'), JSON.stringify({ name: '@kb-labs/e2e-a' }));
    writeFileSync(join(root, 'e2e/package-a/example.mjs'), "const example = 'node:test';\n");
    assert.deepEqual(await e2eNodeTestIssues(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
