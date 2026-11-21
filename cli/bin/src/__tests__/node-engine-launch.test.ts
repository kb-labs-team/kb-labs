import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseNodeEnginePolicy } from '@kb-labs/plugin-contracts/node-engine-policy';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliEntry = join(packageRoot, 'dist/bin.js');
const runtimeManifest = resolve(packageRoot, '../../core/plugin-runtime/package.json');
const requiredMajor = parseNodeEnginePolicy(JSON.parse(readFileSync(runtimeManifest, 'utf8')).engines.node, 'platform').requiredMajor;
const cliVersion = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')).version as string;
const olderNode = findNode(requiredMajor, 'older');
const supportedNode = findNode(requiredMajor, 'supported');

describe('installed CLI Node.js engine preflight', () => {
  // case: S-260.7
  it('keeps installed command modules out of eager entry-point imports', () => {
    const bundledEntry = readFileSync(cliEntry, 'utf8');
    expect(bundledEntry).not.toMatch(/^import\s+.*from ['"]@kb-labs\//m);
    expect(bundledEntry).toContain("import('@kb-labs/plugin-contracts/node-engine-policy')");
  });

  // case: S-260.7
  it('reports the catalogued unsupported engine before loading CLI commands', (context) => {
    if (!olderNode) {
      const reason = '[SKIP] S-260.7 installed CLI integration: no older Node binary found; set KB_TEST_OLD_NODE to a Node executable with a major below the declared policy.';
      console.warn(reason);
      context.skip(reason);
      return;
    }

    expect(existsSync(cliEntry), `built CLI entry missing: ${cliEntry}`).toBe(true);
    const actualVersion = execFileSync(olderNode, ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '');
    const installation = createInstalledCli();
    try {
      const text = runInstalledShim(installation, olderNode, ['marketplace', 'plugins', 'list', '--help']);

      expect(text.error, text.stderr).toBeUndefined();
      expect(text.status, text.stderr).not.toBe(0);
      const textOutput = `${text.stdout}${text.stderr}`;
      expect(textOutput).toContain(`Node.js ${actualVersion} is unsupported`);
      expect(textOutput).toContain(`requires major ${requiredMajor}`);
      expect(textOutput).toContain('KB_NODE_VERSION_UNSUPPORTED');
      expect(textOutput).toContain(`nvm install ${requiredMajor} && nvm use ${requiredMajor}`);
      expect(textOutput).not.toContain('ERR_MODULE_NOT_FOUND');
      expect(textOutput).not.toContain(' at file:');

      const json = runInstalledShim(installation, olderNode, ['marketplace', 'plugins', 'list', '--help', '--json']);
      expect(json.error, json.stderr).toBeUndefined();
      expect(json.status, json.stderr).not.toBe(0);
      expect(json.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
      const result = JSON.parse(json.stdout);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'KB_NODE_VERSION_UNSUPPORTED',
          details: { requiredMajor: String(requiredMajor), actualVersion },
        },
      });
      expect(result.error.message).toContain(`requires major ${requiredMajor}`);
      expect(result.error.hint).toContain(`nvm install ${requiredMajor} && nvm use ${requiredMajor}`);
    } finally {
      rmSync(installation.root, { recursive: true, force: true });
    }
  }, 40000);

  // case: S-260.7
  it('allows the installed command graph under the supported Node major', (context) => {
    if (!supportedNode) {
      const reason = '[SKIP] S-260.7 supported CLI integration: no Node binary matching the declared major found; set KB_TEST_SUPPORTED_NODE.';
      console.warn(reason);
      context.skip(reason);
      return;
    }

    const installation = createInstalledCli();
    try {
      const result = runInstalledShim(installation, supportedNode, ['--version']);
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(cliVersion);
      expect(result.stderr).not.toContain('KB_NODE_VERSION_UNSUPPORTED');
    } finally {
      rmSync(installation.root, { recursive: true, force: true });
    }
  }, 20000);
});

function createInstalledCli(): { root: string; shim: string; platformRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'kb-cli-installed-engine-'));
  const platformRoot = join(root, 'platform');
  const packageInstallRoot = join(platformRoot, 'node_modules/@kb-labs/cli-bin');
  const launcherDirectory = join(root, 'bin');
  mkdirSync(packageInstallRoot, { recursive: true });
  mkdirSync(launcherDirectory, { recursive: true });
  cpSync(join(packageRoot, 'dist'), join(packageInstallRoot, 'dist'), { recursive: true });
  copyFileSync(join(packageRoot, 'package.json'), join(packageInstallRoot, 'package.json'));
  symlinkSync(join(packageRoot, 'node_modules'), join(packageInstallRoot, 'node_modules'), 'dir');
  chmodSync(join(packageInstallRoot, 'dist/bin.js'), 0o755);
  mkdirSync(join(platformRoot, '.kb/v2'), { recursive: true });
  writeFileSync(join(platformRoot, '.kb/v2/receipt.json'), JSON.stringify({
    id: 'test-receipt',
    installationId: 'test-installation',
    plan: { request: { gatewayUrl: 'http://127.0.0.1:4000' }, serviceGraph: { platformVersion: cliVersion } },
    verification: { hostHealthUrl: 'http://127.0.0.1:4000/health' },
  }));
  writeFileSync(join(platformRoot, '.kb/kb.config.jsonc'), JSON.stringify({ platform: { adapters: {} } }));
  const shimTarget = join(platformRoot, '.kb/v2/bin/kb');
  mkdirSync(dirname(shimTarget), { recursive: true });
  // Mirrors kb-create/v2/shim.ensureTarget and Ensure: default KB_HOME, absolute CLI entry, then launcher symlink.
  const cliEntry = join(packageInstallRoot, 'dist/bin.js');
  const defaultKbHome = join(platformRoot, 'state/home');
  writeFileSync(shimTarget, `#!/bin/sh\n# kb-create managed shim\nif [ -z \"\${KB_HOME:-}\" ]; then KB_HOME=${shellQuote(defaultKbHome)}; export KB_HOME; fi\nexec node ${shellQuote(cliEntry)} \"$@\"\n`, { mode: 0o750 });
  const shim = join(launcherDirectory, 'kb');
  symlinkSync(shimTarget, shim);
  return { root, shim, platformRoot };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runInstalledShim(installation: { root: string; shim: string; platformRoot: string }, node: string, args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: installation.root,
    KB_PLATFORM_ROOT: installation.platformRoot,
    PATH: `${dirname(node)}:${process.env.PATH ?? ''}`,
  };
  delete env.KB_HOME;
  delete env.KB_PROJECT_ROOT;
  delete env.KB_PROJECT_ID;
  delete env.KB_NET_OFFSET;
  return spawnSync(installation.shim, args, {
    cwd: installation.root,
    encoding: 'utf8',
    timeout: 15000,
    env,
  });
}

function findNode(requiredMajor: number, relation: 'older' | 'supported'): string | undefined {
  const explicit = process.env[relation === 'older' ? 'KB_TEST_OLD_NODE' : 'KB_TEST_SUPPORTED_NODE'];
  const candidates = explicit
    ? [resolve(explicit)]
    : [...new Set([
      process.env.NVM_DIR,
      join(homedir(), '.nvm'),
      join(userInfo().homedir, '.nvm'),
    ].filter((root): root is string => root !== undefined))]
      .flatMap((root) => {
        const nodeDirectory = join(root, 'versions/node');
        return existsSync(nodeDirectory)
          ? readdirSync(nodeDirectory).sort().reverse().map((version) => join(nodeDirectory, version, 'bin/node'))
          : [];
      });

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      if (explicit) {throw new Error(`${explicit} does not exist: ${candidate}`);}
      continue;
    }
    const version = execFileSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    const major = Number(version.replace(/^v/, '').split('.')[0]);
    if (relation === 'older' ? major < requiredMajor : major === requiredMajor) {return candidate;}
    if (explicit) {
      throw new Error(`${candidate} reports ${version}, which is not ${relation} than Node.js ${requiredMajor}.x as requested.`);
    }
  }
  return undefined;
}
