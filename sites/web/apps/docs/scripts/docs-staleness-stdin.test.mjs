import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('staleness reads a large changed-file list from stdin', () => {
  const input = `${'unrelated/file.ts\n'.repeat(20000)}cli/commands/src/commands/system/workflow.ts\n`;
  const output = execFileSync(process.execPath, ['scripts/docs-staleness.mjs'], {
    cwd: new URL('..', import.meta.url), input, encoding: 'utf8',
    env: { ...process.env, CHANGED_FILES: '' },
  });
  assert.ok(JSON.parse(output).affected.length > 0);
});
