import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(sdkDir, '../..');
const fixtureDir = join(sdkDir, 'test', 'packed-consumer');
const fixtureManifest = JSON.parse(readFileSync(join(fixtureDir, 'package.json'), 'utf8'));
const packages = JSON.parse(execFileSync('corepack', ['pnpm', 'list', '--recursive', '--json', '--depth', '-1'], {
  cwd: workspaceRoot,
  encoding: 'utf8',
}));
const packageByName = new Map(packages.map((item) => [item.name, item]));
const closure = new Set();

function includePackage(name) {
  if (closure.has(name)) return;
  const workspacePackage = packageByName.get(name);
  if (!workspacePackage) return;
  closure.add(name);
  const manifest = JSON.parse(readFileSync(join(workspacePackage.path, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const dependency of Object.keys(manifest[field] ?? {})) includePackage(dependency);
  }
}

includePackage('@kb-labs/sdk');
if (fixtureManifest.dependencies?.['@kb-labs/sdk'] !== packageByName.get('@kb-labs/sdk')?.version) {
  throw new Error('Packed consumer must depend on the current @kb-labs/sdk version.');
}
if (Object.keys(fixtureManifest.dependencies ?? {}).some((name) => name !== '@kb-labs/sdk')) {
  throw new Error('Packed consumer may declare only @kb-labs/sdk as a KB Labs dependency.');
}

const tempRoot = mkdtempSync(join(tmpdir(), 'kb-sdk-packed-consumer-'));
const tarballDir = join(tempRoot, 'tarballs');
const consumerDir = join(tempRoot, 'consumer');
const isolatedHome = join(tempRoot, 'home');
const env = {
  ...process.env,
  HOME: isolatedHome,
  npm_config_cache: join(tempRoot, 'npm-cache'),
  npm_config_package_lock: 'false',
};
for (const name of ['KB_PLATFORM_ROOT', 'KB_HOME', 'KB_NET_OFFSET', 'GOFLAGS', 'KB_JOURNEY_PACKAGES_READY']) {
  delete env[name];
}

try {
  mkdirSync(tarballDir, { recursive: true });
  cpSync(fixtureDir, consumerDir, { recursive: true });
  const packPaths = [];
  for (const name of [...closure].sort()) {
    const workspacePackage = packageByName.get(name);
    const before = new Set(readdirSync(tarballDir, { withFileTypes: true }).map((entry) => entry.name));
    execFileSync('corepack', ['pnpm', 'pack', '--pack-destination', tarballDir], {
      cwd: workspacePackage.path,
      env,
      stdio: 'ignore',
    });
    const added = readdirSync(tarballDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !before.has(entry.name));
    if (added.length !== 1) throw new Error(`Expected one packed tarball for ${name}, found ${added.length}.`);
    packPaths.push(join(tarballDir, added[0].name));
  }

  execFileSync('npm', [
    'install', '--no-save', '--package-lock=false',
    ...packPaths,
    ...Object.entries(fixtureManifest.devDependencies ?? {}).map(([name, version]) => `${name}@${version}`),
  ], { cwd: consumerDir, env, stdio: 'inherit' });

  for (const script of ['type-check', 'build', 'studio-config', 'test']) {
    execFileSync('npm', ['run', script], { cwd: consumerDir, env, stdio: 'inherit' });
  }
  const bytes = (directory) => readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const path = join(directory, entry.name);
    return total + (entry.isDirectory() ? bytes(path) : statSync(path).size);
  }, 0);
  console.log(`PASS: packed SDK dependency closure (${closure.size} workspace packages) resolved in an external plugin; type-check, build, Studio config, and unit test passed.`);
  console.log(`Temporary fixture artifacts removed; ${bytes(tempRoot)} bytes cleaned.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
