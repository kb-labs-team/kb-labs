import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'remote-changed-files.mjs');

// case: S-262.7
test('cross-package rename manifest retains old and new package paths', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-changed-files-rename-'));
  const manifest = path.join(temporaryRoot, 'changed.json');
  const git = (args) => execFileSync('git', args, { cwd: temporaryRoot, stdio: 'pipe' }).toString().trim();
  try {
    git(['init', '-q']);
    git(['config', 'user.name', 'Remote verification fixture']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    mkdirSync(path.join(temporaryRoot, 'packages/a/src'), { recursive: true });
    writeFileSync(path.join(temporaryRoot, 'packages/a/src/moved.ts'), 'export const moved = true;\n');
    git(['add', '.']);
    git(['commit', '-qm', 'base']);
    const base = git(['rev-parse', 'HEAD']);
    mkdirSync(path.join(temporaryRoot, 'packages/b/src'), { recursive: true });
    git(['mv', 'packages/a/src/moved.ts', 'packages/b/src/moved.ts']);
    const result = spawnSync(process.execPath, [script], {
      cwd: temporaryRoot,
      encoding: 'utf8',
      env: { ...process.env, KB_DEVKIT_BASE_REF: base, VERIFICATION_PROFILE: 'stream', KB_REMOTE_CHANGED_FILES_PATH: manifest },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const paths = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.deepEqual(paths.sort(), ['packages/a/src/moved.ts', 'packages/b/src/moved.ts']);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

// case: S-262.7
test('candidate selection diffs an agent stream against its supplied integration base', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-changed-files-candidate-'));
  const manifest = path.join(temporaryRoot, 'changed.json');
  const git = (args) => execFileSync('git', args, { cwd: temporaryRoot, stdio: 'pipe' }).toString().trim();
  try {
    git(['init', '-q']);
    git(['config', 'user.name', 'Remote verification fixture']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    mkdirSync(path.join(temporaryRoot, 'packages/a/src'), { recursive: true });
    writeFileSync(path.join(temporaryRoot, 'packages/a/src/base.ts'), 'export const base = true;\n');
    git(['add', '.']);
    git(['commit', '-qm', 'integration base']);
    const base = git(['rev-parse', 'HEAD']);
    writeFileSync(path.join(temporaryRoot, 'packages/a/src/base.ts'), 'export const base = true;\nexport const changed = true;\n');
    git(['commit', '-qam', 'stream change']);
    const stream = git(['rev-parse', 'HEAD']);
    git(['checkout', '-qb', 'integration', base]);
    writeFileSync(path.join(temporaryRoot, 'packages/a/src/integration.ts'), 'export const integration = true;\n');
    git(['add', '.']);
    git(['commit', '-qm', 'integration advanced']);
    git(['checkout', '-q', stream]);
    const result = spawnSync(process.execPath, [script], {
      cwd: temporaryRoot,
      encoding: 'utf8',
      env: { ...process.env, KB_DEVKIT_BASE_REF: 'integration', VERIFICATION_PROFILE: 'candidate', KB_REMOTE_CHANGED_FILES_PATH: manifest },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')), ['packages/a/src/base.ts']);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
