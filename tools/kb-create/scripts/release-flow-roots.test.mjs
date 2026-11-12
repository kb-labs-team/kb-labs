import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseFlowRoots } from './release-flow-roots.mjs';

const script = fileURLToPath(new URL('./release-flow-roots.mjs', import.meta.url));
const configPath = fileURLToPath(new URL('../../../.kb/kb.config.jsonc', import.meta.url));
const manifestPath = fileURLToPath(new URL('../../../e2e/platform/registry-manifest.json', import.meta.url));

test('the platform flow roots come from the declared platform members and the release registry', () => {
  const roots = releaseFlowRoots({ configPath, manifestPath, flow: 'platform' });
  for (const name of ['@kb-labs/cli-bin', '@kb-labs/core-workspace', '@kb-labs/host-agent-app', '@kb-labs/core-runtime', '@kb-labs/sdk', '@kb-labs/gateway-app']) {
    assert.ok(roots.includes(name), `${name} is a root of the platform flow`);
  }
  assert.equal(new Set(roots).size, roots.length, 'roots are unique');
  assert.ok(!roots.some(name => name.includes('web-site') || name.includes('docs-site')), 'product apps are never roots');
});

test('an undeclared flow exits non-zero and lists the declared flows', () => {
  const result = spawnSync(process.execPath, [script, 'no-such-flow'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /"no-such-flow" is not declared/);
  assert.match(result.stderr, /declared flows: platform/);
});

test('the command prints the roots as one comma-separated line for --packages', () => {
  const result = spawnSync(process.execPath, [script, 'platform'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const names = result.stdout.trim().split(',');
  assert.ok(names.includes('@kb-labs/cli-bin'));
  assert.deepEqual(names, releaseFlowRoots({ configPath, manifestPath, flow: 'platform' }));
});
