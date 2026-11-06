import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const checkScript = join(repositoryRoot, 'e2e/scripts/check-frozen-lockfile.sh');

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function treeSnapshot(root) {
  const entries = [];
  const visit = (path, relativePath) => {
    const stat = lstatSync(path, { bigint: true });
    const entry = {
      path: relativePath,
      mode: stat.mode.toString(),
      ino: stat.ino.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
      size: stat.size.toString(),
    };
    if (stat.isSymbolicLink()) {
      entry.link = readlinkSync(path);
    } else if (stat.isDirectory()) {
      entry.type = 'directory';
      entries.push(entry);
      for (const child of readdirSync(path).sort()) {
        visit(join(path, child), relativePath ? `${relativePath}/${child}` : child);
      }
      return;
    } else if (stat.isFile()) {
      entry.type = 'file';
      entry.content = hash(path);
    } else {
      entry.type = 'other';
    }
    entries.push(entry);
  };

  try {
    visit(root, '');
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  }
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function pnpm(args, cwd, env) {
  return execFileSync('corepack', ['pnpm', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('candidate lock check refuses stale manifests without rewriting the lockfile', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kb-frozen-lockfile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  writeJson(join(workspace, 'package.json'), {
    name: 'frozen-lockfile-fixture',
    private: true,
    packageManager: 'pnpm@11.4.0',
  });
  writeJson(join(workspace, 'packages/core/package.json'), {
    name: '@fixture/core',
    version: '1.0.0',
  });
  const appManifestPath = join(workspace, 'packages/app/package.json');
  writeJson(appManifestPath, {
    name: '@fixture/app',
    version: '1.0.0',
    dependencies: { '@fixture/core': 'workspace:*' },
  });

  const env = {
    ...process.env,
    HOME: home,
    COREPACK_HOME: process.env.COREPACK_HOME ?? join(homedir(), '.cache/node/corepack'),
    npm_config_ignore_scripts: 'true',
  };
  for (const key of ['KB_PLATFORM_ROOT', 'KB_HOME', 'KB_NET_OFFSET', 'GOFLAGS', 'CI', 'npm_config_frozen_lockfile']) {
    delete env[key];
  }
  const offlineEnv = {
    ...env,
    npm_config_registry: 'http://127.0.0.1:9/',
    npm_config_offline: 'true',
  };
  pnpm(['install', '--lockfile-only', '--offline', '--ignore-scripts'], workspace, offlineEnv);

  const lockPath = join(workspace, 'pnpm-lock.yaml');
  const nodeModulesPath = join(workspace, 'node_modules');
  const currentHash = hash(lockPath);
  const currentNodeModules = treeSnapshot(nodeModulesPath);
  assert.equal(currentNodeModules, 'absent', 'lockfile-only fixture setup must not create node_modules');
  const current = execFileSync('bash', [checkScript], {
    cwd: workspace,
    env: offlineEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(current, /Lockfile is current/);
  assert.equal(hash(lockPath), currentHash);
  assert.equal(treeSnapshot(nodeModulesPath), currentNodeModules,
    'current frozen validation must leave node_modules unchanged');

  writeJson(appManifestPath, {
    name: '@fixture/app',
    version: '1.0.0',
    devDependencies: { '@fixture/core': 'workspace:*' },
  });
  const staleHash = hash(lockPath);
  let result;
  try {
    execFileSync('bash', [checkScript], {
      cwd: workspace,
      env: offlineEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    result = error;
  }
  assert.ok(result, 'stale workspace manifests must fail the frozen-lockfile check');
  const staleMessage = `${result.stderr}${result.stdout}`;
  assert.match(staleMessage, /ERR_PNPM_OUTDATED_LOCKFILE/);
  assert.match(staleMessage, /pnpm install --no-frozen-lockfile/);
  assert.doesNotMatch(staleMessage, /ECONNREFUSED|ERR_PNPM_NO_OFFLINE_META|ENOTFOUND/);
  assert.equal(hash(lockPath), staleHash, 'frozen validation must not rewrite pnpm-lock.yaml');
  assert.equal(treeSnapshot(nodeModulesPath), currentNodeModules,
    'stale frozen validation must leave node_modules unchanged');
});
