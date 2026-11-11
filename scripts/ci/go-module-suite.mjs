#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { globSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registryReader = path.join(workspaceRoot, 'scripts/read-go-binary-registry.mjs');

function usage() {
  return 'Usage: node scripts/ci/go-module-suite.mjs [--registry <devkit.yaml>] [--root <workspace>] [--go <go-command>] [--module <path> ...]';
}

function parseArgs(args) {
  const options = { root: workspaceRoot, go: 'go', modules: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--help') return { help: true };
    if (!['--registry', '--root', '--go', '--module'].includes(flag) || !args[index + 1]) {
      throw new Error(`${usage()}\nInvalid or incomplete argument: ${flag}`);
    }
    const value = args[++index];
    if (flag === '--module') options.modules.push(value);
    else options[flag.slice(2)] = value;
  }
  return options;
}

function discoverModules(root, registryPath) {
  const result = spawnSync(process.execPath, [registryReader, '--config', registryPath], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`Go module registry discovery failed: ${result.stderr.trim() || result.stdout.trim()}`);
  let patterns;
  try {
    patterns = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Go module registry discovery returned invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(patterns) || patterns.length === 0) throw new Error('Go module registry discovery returned an empty set');

  const modules = new Set();
  for (const pattern of patterns) {
    const matches = globSync(pattern, { cwd: root, withFileTypes: true });
    const directories = matches
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(entry.parentPath, entry.name))
      .filter((directory) => {
        try { return statSync(path.join(directory, 'go.mod')).isFile(); }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      });
    if (directories.length === 0) throw new Error(`Go module registry pattern matched no modules: ${pattern}`);
    for (const directory of directories) modules.add(path.relative(root, directory));
  }
  if (modules.size === 0) throw new Error('Go module registry discovery returned an empty set');
  return [...modules].sort();
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

function goPackages(go, moduleDir, env) {
  const result = run(go, ['list', './...'], { cwd: moduleDir, env });
  if (result.status !== 0) throw new Error(`go list failed in ${path.relative(workspaceRoot, moduleDir)}: ${result.stderr.trim()}`);
  const packages = result.stdout.split(/\r?\n/).filter(Boolean).filter((name) => !name.split('/').includes('e2e'));
  if (packages.length === 0) throw new Error(`No non-e2e Go packages found in ${path.relative(workspaceRoot, moduleDir)}`);
  return packages;
}

function unixSocketPathLimitBytes(probeRoot) {
  const source = `
    import net from 'node:net';
    import path from 'node:path';
    const root = process.argv[1];
    async function canBind(nameLength) {
      const server = net.createServer();
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(path.join(root, 's'.repeat(nameLength)), resolve);
        });
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        return true;
      } catch (error) {
        if (server.listening) await new Promise((resolve) => server.close(resolve));
        if (error.code === 'EINVAL' || error.code === 'ENAMETOOLONG') return false;
        throw error;
      }
    }
    let low = 0;
    let high = 256;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (await canBind(middle)) low = middle;
      else high = middle;
    }
    process.stdout.write(String(Buffer.byteLength(path.join(root, 's'.repeat(low)))));
  `;
  const result = run(process.execPath, ['--input-type=module', '-e', source, probeRoot], { cwd: workspaceRoot });
  const limit = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`GO_SUITE_SOCKET_PATH_LIMIT_UNAVAILABLE: could not derive the host Unix socket pathname capacity: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return limit;
}

function socketProbeFailure(detail) {
  const error = new Error(`GO_SUITE_SOCKET_PATH_PROBE_FAILED: ${detail}`);
  error.code = 'GO_SUITE_SOCKET_PATH_PROBE_FAILED';
  return error;
}

function tsxSocketSuffix(directory) {
  const probeScript = path.join(directory, 'socket-path-probe.ts');
  const tsx = path.join(workspaceRoot, 'services/gateway/app/node_modules/.bin/tsx');
  const source = `
    import { lstatSync, readdirSync } from 'node:fs';
    import path from 'node:path';
    function findSocket(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        const details = lstatSync(candidate);
        if (details.isSocket()) return candidate;
        if (details.isDirectory()) {
          const nested = findSocket(candidate);
          if (nested) return nested;
        }
      }
      return undefined;
    }
    const socketPath = findSocket(process.env.TMPDIR);
    if (!socketPath) process.exitCode = 1;
    else process.stdout.write(JSON.stringify({ socketPath }) + '\\n');
  `;
  try {
    writeFileSync(probeScript, source);
    const result = run(tsx, [probeScript], {
      cwd: workspaceRoot,
      env: { ...process.env, TMPDIR: directory },
      timeout: 10_000,
    });
    if (result.status !== 0) {
      throw socketProbeFailure(`TSX could not expose its Unix socket under ${directory}: ${result.error?.message || result.stderr.trim() || result.stdout.trim()}`);
    }
    const { socketPath } = JSON.parse(result.stdout.trim());
    const suffix = path.relative(directory, socketPath);
    if (!path.isAbsolute(socketPath) || !suffix || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix)) {
      throw socketProbeFailure(`TSX returned an unexpected socket location under ${directory}`);
    }
    return suffix;
  } catch (error) {
    if (error.code === 'GO_SUITE_SOCKET_PATH_PROBE_FAILED') throw error;
    throw socketProbeFailure(`could not derive the TSX Unix socket path under ${directory}: ${error.message}`);
  } finally {
    rmSync(probeScript, { force: true });
  }
}

function validateTmpRoot(variant, directory, socketPathLimit, socketSuffix) {
  const socketPath = path.join(directory, socketSuffix);
  const requiredBytes = Buffer.byteLength(socketPath);
  if (requiredBytes > socketPathLimit) {
    const shorterTmpDir = shorterTmpDirFor(directory, socketPathLimit, socketSuffix);
    throw new Error(`GO_SUITE_TMPDIR_SOCKET_PATH_TOO_LONG: variant ${variant} at ${directory} needs ${requiredBytes} bytes for its TSX IPC socket path, but this host accepts ${socketPathLimit}. ${tmpdirRerunCommand(shorterTmpDir)}`);
  }
}

function shorterTmpDirFor(directory, socketPathLimit, socketSuffix) {
  const candidates = [...new Set(['/tmp', os.tmpdir()])]
    .filter((base) => Buffer.byteLength(base) < Buffer.byteLength(directory))
    .filter((base) => Buffer.byteLength(path.join(base, 'g-XXXXXX', socketSuffix)) <= socketPathLimit);
  candidates.sort((left, right) => Buffer.byteLength(left) - Buffer.byteLength(right));
  return candidates[0] ?? '/tmp';
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function tmpdirRerunCommand(tmpdir) {
  const registeredRerun = process.env.KB_DEVKIT_CHECK_RERUN;
  const invocation = registeredRerun ?? [process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)]
    .map(shellQuote)
    .join(' ');
  return `Rerun with: TMPDIR=${shellQuote(tmpdir)} ${invocation}`;
}

function runSuite({ root = workspaceRoot, registry, go = 'go', modules = [] } = {}) {
  const registryPath = registry ?? path.join(root, 'devkit.yaml');
  const discovered = discoverModules(root, registryPath);
  const selected = modules.length ? discovered.filter((module) => modules.includes(module)) : discovered;
  const unknown = modules.filter((module) => !discovered.includes(module));
  if (unknown.length) throw new Error(`Requested Go modules are not in the devkit registry: ${unknown.join(', ')}`);
  if (selected.length === 0) throw new Error('Go module registry selection returned an empty set');

  const moduleCache = process.env.GOMODCACHE ?? path.join(os.homedir(), 'go', 'pkg', 'mod');
  const buildCache = process.env.GOCACHE ?? path.join(
    os.homedir(), ...(os.platform() === 'darwin' ? ['Library', 'Caches', 'go-build'] : ['.cache', 'go-build']),
  );
  const temporaryRoots = [];
  const homes = [];
  let failed = false;
  try {
    const plans = [
      ['one', '/tmp', 'kg-'],
      ['two', os.tmpdir(), 'g-'],
    ];
    for (const [variant, base, prefix] of plans) {
      for (const module of selected) {
        temporaryRoots.push({ variant, module, directory: mkdtempSync(path.join(base, prefix)) });
      }
    }
    const socketPathLimit = unixSocketPathLimitBytes(temporaryRoots[0].directory);
    const socketSuffix = tsxSocketSuffix(temporaryRoots[0].directory);
    for (const { variant, module, directory } of temporaryRoots) {
      validateTmpRoot(`${variant} for ${module}`, directory, socketPathLimit, socketSuffix);
    }

    for (const { variant, module, directory } of temporaryRoots) {
      const moduleDir = path.join(root, module);
      const home = mkdtempSync(path.join(directory, 'h-'));
      homes.push(home);
      const env = {
        ...process.env,
        HOME: home,
        TMPDIR: directory,
        GOMODCACHE: moduleCache,
        GOCACHE: buildCache,
        KB_TEST_DEADLINE_SCALE: process.env.KB_TEST_DEADLINE_SCALE ?? '2',
      };
      for (const name of ['KB_PLATFORM_ROOT', 'KB_HOME', 'KB_NET_OFFSET', 'GOFLAGS']) delete env[name];
      const label = `${module} [TMPDIR ${variant}]`;
      try {
        const packages = goPackages(go, moduleDir, env);
        if (variant === 'one') {
          const linuxVet = run(go, ['vet', ...packages], { cwd: moduleDir, env: { ...env, GOOS: 'linux' } });
          if (linuxVet.status !== 0) {
            failed = true;
            process.stderr.write(`${label} [GOOS=linux go vet]: FAIL\n${linuxVet.stdout}${linuxVet.stderr}`);
          }
        }
        const test = run(go, ['test', ...packages], { cwd: moduleDir, env });
        if (test.status !== 0) {
          failed = true;
          process.stderr.write(`${label}: FAIL\n${test.stdout}${test.stderr}`);
        } else {
          process.stdout.write(`${label}: PASS (${packages.length} packages)\n`);
        }
      } catch (error) {
        failed = true;
        process.stderr.write(`${label}: FAIL — ${error.message}\n`);
      }
    }
  } finally {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
    for (const { directory } of temporaryRoots) rmSync(directory, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(`${usage()}\n`);
    else process.exitCode = runSuite(options);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export { discoverModules, runSuite };
