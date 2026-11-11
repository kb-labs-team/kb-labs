import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const migrationScripts = [
  ['adapters/analytics-sqlite/scripts/migrate-from-jsonl.mjs', 'analytics/analytics.sqlite'],
  ['adapters/analytics-duckdb/scripts/migrate-from-jsonl.mjs', 'analytics/analytics.duckdb'],
];

// case: S-228.1
test('analytics migration scripts resolve their default files from the shared platform data root', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'kb-data-root-migration-'));
  try {
    const installRoot = path.join(temporaryRoot, 'install');
    const versionRoot = path.join(installRoot, 'versions', 'v1');
    const activeRoot = path.join(installRoot, 'current');
    const dataRoot = path.join(installRoot, 'state', 'data');
    const contract = path.join(versionRoot, '.kb/v2/platform-layout.json');
    const projectedData = path.join(versionRoot, '.kb/data');
    await Promise.all([
      mkdir(path.dirname(contract), { recursive: true }),
      mkdir(dataRoot, { recursive: true }),
      mkdir(path.join(dataRoot, 'analytics', 'buffer'), { recursive: true }),
    ]);
    await writeFile(contract, await readFile(path.join(workspaceRoot, 'tools/kb-create/v2/contracts/platform-layout.json')));
    await writeFile(path.join(dataRoot, 'analytics', 'buffer', 'events.jsonl'), `${JSON.stringify({
      id: 'evt-fixture', type: 'event', ts: '2026-10-11T12:00:00.000Z',
      source: { product: 'fixture', version: '1.0.0' }, actor: { type: 'user', id: 'fixture', name: 'Fixture' },
      ctx: {}, payload: { marker: 'fixture' },
    })}\n`);
    await symlink(path.relative(path.dirname(projectedData), dataRoot), projectedData, 'dir');
    await symlink(versionRoot, activeRoot, 'dir');
    const canonicalDataRoot = await realpath(dataRoot);

    for (const [script, database] of migrationScripts) {
      const result = spawnSync(process.execPath, [
        path.join(workspaceRoot, script), '--platform-root', activeRoot, '--dry-run',
      ], { cwd: workspaceRoot, encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, new RegExp(`Source: ${escapeRegex(path.join(canonicalDataRoot, 'analytics', 'buffer'))}`));
      assert.match(result.stdout, new RegExp(`Database: ${escapeRegex(path.join(canonicalDataRoot, database))}`));
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

// case: S-228.2
test('analytics migration scripts require an explicit platform root', () => {
  for (const [script] of migrationScripts) {
    const env = { ...process.env };
    delete env.KB_PLATFORM_ROOT;
    const result = spawnSync(process.execPath, [path.join(workspaceRoot, script), '--dry-run'], {
      cwd: workspaceRoot, env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Pass --platform-root <path> or set KB_PLATFORM_ROOT/);
  }
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
