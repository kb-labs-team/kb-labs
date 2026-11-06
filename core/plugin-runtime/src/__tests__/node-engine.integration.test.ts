import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createErrorEnvelope, getCatalogEntry } from '@kb-labs/core-platform';
import { describe, expect, it } from 'vitest';
import { nodeVersionSupported, readNodeEnginePolicy } from '../platform-resolve/node-engine.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtimeManifest = join(packageRoot, 'package.json');
const runtimeEntry = join(packageRoot, 'dist/index.js');
const requiredMajor = readNodeEnginePolicy(runtimeManifest).requiredMajor;
const olderNode = findOlderNode();

describe('built runtime Node.js engine boundary', () => {
  // case: S-260.1
  it('reports the catalogued engine refusal under a real older Node binary', (context) => {
    if (!olderNode) {
      const reason = '[SKIP] S-260.1 built-runtime integration: no older Node binary found; set KB_TEST_OLD_NODE to a Node executable with a major below the declared policy.';
      console.warn(reason);
      context.skip(reason);
      return;
    }
    expect(existsSync(runtimeEntry), `built runtime entry missing: ${runtimeEntry}`).toBe(true);
    const actualVersion = execFileSync(olderNode, ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '');
    const entryUrl = pathToFileURL(runtimeEntry).href;
    const program = `
      import { installPlatformResolveHook } from ${JSON.stringify(entryUrl)};
      try {
        installPlatformResolveHook({ platformRoot: process.cwd() });
        process.stdout.write(JSON.stringify({ unexpectedSuccess: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({
          envelope: error?.envelope,
          actualVersion: process.versions.node,
        }));
      }
    `;
    const result = spawnSync(olderNode, ['--input-type=module', '--eval', program], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 15000,
    });

    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('TypeError');
    expect(result.stdout + result.stderr).not.toContain('TypeError');
    const response = JSON.parse(result.stdout);
    expect(response.unexpectedSuccess).toBeUndefined();
    const catalog = getCatalogEntry('KB_NODE_VERSION_UNSUPPORTED');
    expect(catalog).toBeDefined();
    const expected = createErrorEnvelope('KB_NODE_VERSION_UNSUPPORTED', {
      details: { requiredMajor: String(requiredMajor), actualVersion },
    });
    expect(response.envelope).toMatchObject({
      code: 'KB_NODE_VERSION_UNSUPPORTED',
      details: { requiredMajor: String(requiredMajor), actualVersion },
      message: expected.message,
      hint: expected.hint,
    });
  }, 20000);
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
      if (explicit) throw new Error(`KB_TEST_OLD_NODE does not exist: ${candidate}`);
      throw new Error(`NVM Node executable does not exist: ${candidate}`);
    }
    const version = execFileSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (!nodeVersionSupported(requiredMajor, version)) return candidate;
    if (explicit) {
      throw new Error(`KB_TEST_OLD_NODE ${candidate} reports ${version}, which satisfies Node.js ${requiredMajor}.x; choose an older Node binary.`);
    }
  }
  return undefined;
}
