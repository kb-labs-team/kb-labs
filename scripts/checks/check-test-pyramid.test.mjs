import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHECK_RESULT_FILE_ENV } from './lib/check-result.mjs';

const script = fileURLToPath(new URL('./check-test-pyramid.mjs', import.meta.url));

test('test-pyramid check writes its structured result to the shared file channel', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'test-pyramid-output-'));
  const resultPath = path.join(root, 'result.json');
  try {
    const commands = path.join(root, 'src/commands');
    mkdirSync(commands, { recursive: true });
    for (let index = 0; index < 900; index += 1) {
      writeFileSync(path.join(commands, `command-${index}.ts`), 'export {};');
    }
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, [CHECK_RESULT_FILE_ENV]: resultPath, KB_DEVKIT_CHECK_NAME: 'test-pyramid' },
      input: JSON.stringify({ package: { name: 'fixture', scripts: { 'test:cli': 'vitest run' } } }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(output.issues.length, 901);
    assert.deepEqual(output.issues[0], {
      check: 'test-pyramid',
      severity: 'warning',
      message: 'Command "command-0.ts" has no handler test. Add src/__tests__/cli/command-0.cli.test.ts.',
      file: 'src/__tests__/cli/command-0.cli.test.ts',
      fix: 'touch src/__tests__/cli/command-0.cli.test.ts',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
