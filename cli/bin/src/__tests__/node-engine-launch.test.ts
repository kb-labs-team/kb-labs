import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseNodeEnginePolicy } from '@kb-labs/plugin-contracts/node-engine-policy';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliEntry = join(packageRoot, 'dist/bin.js');
const runtimeManifest = resolve(packageRoot, '../../core/plugin-runtime/package.json');
const requiredMajor = parseNodeEnginePolicy(JSON.parse(readFileSync(runtimeManifest, 'utf8')).engines.node, 'platform').requiredMajor;
const olderNode = findOlderNode();

describe('installed CLI Node.js engine preflight', () => {
  // case: S-260.7
  it('keeps the installed command graph out of the eager entry-point imports', () => {
    const source = readFileSync(cliEntry, 'utf8');
    expect(source).not.toMatch(/^import\s+.*from ['"]@kb-labs\//m);
    expect(source).toContain("import('@kb-labs/plugin-contracts/node-engine-policy')");
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
    const text = spawnSync(olderNode, [cliEntry, 'marketplace', 'plugins', 'list', '--help'], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 15000,
    });

    expect(text.error, text.stderr).toBeUndefined();
    expect(text.status, text.stderr).not.toBe(0);
    const textOutput = `${text.stdout}${text.stderr}`;
    expect(textOutput).toContain(`Node.js ${actualVersion} is unsupported`);
    expect(textOutput).toContain(`requires major ${requiredMajor}`);
    expect(textOutput).toContain('KB_NODE_VERSION_UNSUPPORTED');
    expect(textOutput).toContain(`nvm install ${requiredMajor} && nvm use ${requiredMajor}`);
    expect(textOutput).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(textOutput).not.toContain(' at file:');

    const json = spawnSync(olderNode, [cliEntry, 'marketplace', 'plugins', 'list', '--help', '--json'], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 15000,
    });
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
  }, 40000);
});

function findOlderNode(): string | undefined {
  const explicit = process.env.KB_TEST_OLD_NODE;
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
      if (explicit) {throw new Error(`KB_TEST_OLD_NODE does not exist: ${candidate}`);}
      continue;
    }
    const version = execFileSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (Number(version.replace(/^v/, '').split('.')[0]) < requiredMajor) {return candidate;}
    if (explicit) {
      throw new Error(`KB_TEST_OLD_NODE ${candidate} reports ${version}, which satisfies Node.js ${requiredMajor}.x; choose an older Node binary.`);
    }
  }
  return undefined;
}
