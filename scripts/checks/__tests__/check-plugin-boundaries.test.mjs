import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collect } from '../check-plugin-boundaries.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kb-plugin-boundaries-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'plugins/example');
  const platform = path.join(root, 'core/runtime');
  await mkdir(path.join(plugin, 'src'), { recursive: true });
  await mkdir(path.join(platform, 'src'), { recursive: true });
  await writeFile(path.join(plugin, 'package.json'), JSON.stringify({
    name: '@kb-labs/example',
    dependencies: { '@kb-labs/sdk': 'workspace:*' },
    devDependencies: { '@kb-labs/devkit': 'workspace:*' },
  }));
  await writeFile(path.join(plugin, 'src/index.ts'), "import { defineCommand } from '@kb-labs/sdk/command';\n");
  await writeFile(path.join(platform, 'package.json'), JSON.stringify({ name: '@kb-labs/core-runtime' }));
  await writeFile(path.join(platform, 'src/index.ts'), 'export const runtime = true;\n');
  return {
    root,
    plugin,
    platform,
    packages: [
      { name: '@kb-labs/example', dir: 'plugins/example', language: 'typescript' },
      { name: '@kb-labs/core-runtime', dir: 'core/runtime', language: 'typescript' },
    ],
  };
}

const has = (issues, fragment) => issues.some(({ message }) => message.includes(fragment));

test('plugin graph and SDK-only boundaries accept the canonical root package', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await collect(f.root, f.packages), []);
});

test('workspace registry packages without npm manifests are outside npm boundary checks', async (t) => {
  const f = await fixture(t);
  f.packages.push({ name: 'kb-create', dir: 'tools/kb-create', language: 'go' });
  await mkdir(path.join(f.root, 'tools/kb-create'), { recursive: true });
  assert.deepEqual(await collect(f.root, f.packages), []);
});

test('one-package rail rejects and then clears a nested workspace package', async (t) => {
  const f = await fixture(t);
  const nested = path.join(f.plugin, 'core');
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, 'package.json'), JSON.stringify({ name: '@kb-labs/example-core' }));
  f.packages.push({ name: '@kb-labs/example-core', dir: 'plugins/example/core', language: 'typescript' });
  assert.ok(has(await collect(f.root, f.packages), 'plugin root must be exactly one workspace package'));
  f.packages.pop();
  await rm(nested, { recursive: true, force: true });
  assert.deepEqual(await collect(f.root, f.packages), []);
});

test('plugin runtime rail rejects a platform package dependency and clears it', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.plugin, 'package.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  original.dependencies['@kb-labs/core-runtime'] = 'workspace:*';
  await writeFile(file, JSON.stringify(original));
  assert.ok(has(await collect(f.root, f.packages), 'plugin runtime @kb-labs dependencies must use @kb-labs/sdk'));
  delete original.dependencies['@kb-labs/core-runtime'];
  await writeFile(file, JSON.stringify(original));
  assert.deepEqual(await collect(f.root, f.packages), []);
});

test('plugin runtime rail rejects a platform package peer dependency and clears it', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.plugin, 'package.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  original.peerDependencies = { '@kb-labs/core-runtime': 'workspace:*' };
  await writeFile(file, JSON.stringify(original));
  assert.ok(has(await collect(f.root, f.packages), 'plugin runtime @kb-labs dependencies must use @kb-labs/sdk'));

  original.peerDependencies = { '@kb-labs/sdk': 'workspace:*' };
  await writeFile(file, JSON.stringify(original));
  assert.deepEqual(await collect(f.root, f.packages), []);
});

test('platform graph rail rejects plugin package edges and clears them', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.platform, 'package.json');
  await writeFile(file, JSON.stringify({ name: '@kb-labs/core-runtime', dependencies: { '@kb-labs/example': 'workspace:*' } }));
  assert.ok(has(await collect(f.root, f.packages), 'is a plugin package dependency of a platform package'));
  await writeFile(file, JSON.stringify({ name: '@kb-labs/core-runtime' }));
  assert.deepEqual(await collect(f.root, f.packages), []);
});

test('source import rail rejects platform and plugin imports outside the SDK', async (t) => {
  const f = await fixture(t);
  const pluginSource = path.join(f.plugin, 'src/index.ts');
  await writeFile(pluginSource, "import { platform } from '@kb-labs/core-runtime';\n");
  assert.ok(has(await collect(f.root, f.packages), 'plugin import outside its own package and @kb-labs/sdk'));
  await writeFile(pluginSource, "import { defineCommand } from '@kb-labs/sdk/command';\n");
  await writeFile(pluginSource, "import { command } from '@kb-labs/example/command';\n");
  assert.deepEqual(await collect(f.root, f.packages), []);
  await writeFile(pluginSource, "import { defineCommand } from '@kb-labs/sdk/command';\n");
  const pluginTest = path.join(f.plugin, 'tests/index.test.ts');
  await mkdir(path.dirname(pluginTest), { recursive: true });
  await writeFile(pluginTest, "import '@kb-labs/core-runtime';\n");
  assert.ok(has(await collect(f.root, f.packages), 'plugin import outside its own package and @kb-labs/sdk'));
  await writeFile(pluginTest, "import '@kb-labs/sdk/testing';\n");
  assert.deepEqual(await collect(f.root, f.packages), []);
  const platformSource = path.join(f.platform, 'src/index.ts');
  await writeFile(platformSource, "import '@kb-labs/example';\n");
  assert.ok(has(await collect(f.root, f.packages), 'imports a plugin package from a platform package'));
  await writeFile(platformSource, 'export const runtime = true;\n');
  assert.deepEqual(await collect(f.root, f.packages), []);
});
