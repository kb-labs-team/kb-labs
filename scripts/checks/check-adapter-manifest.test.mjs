import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runExternalCheck } from './lib/run-external-check.mjs';

const checker = fileURLToPath(new URL('./check-adapter-manifest.mjs', import.meta.url));

test('adapter-manifest uses devkit categories and validates built manifests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kb-adapter-manifest-check-'));
  try {
    const adapterRoot = path.join(root, 'adapters', 'adapter');
    const extraRoot = path.join(root, 'packages', 'extra');
    await writeFixturePackage(adapterRoot, '@fixture/adapter', adapterManifest({ implements: 'IFixture' }));
    await writeFixturePackage(extraRoot, '@fixture/extra', adapterManifest({ implements: 'IFixture', configSchema: {} }));

    const adapterPackage = { name: '@fixture/adapter', dir: adapterRoot, relPath: 'adapters/adapter', category: 'adapter', language: 'typescript' };
    const extraPackage = { name: '@fixture/extra', dir: extraRoot, relPath: 'packages/extra', category: 'ts-lib', language: 'typescript' };
    const payload = {
      workspaceRoot: root,
      check: 'adapter-manifest',
      package: { Name: adapterPackage.name, Dir: adapterRoot, RelPath: adapterPackage.relPath, Category: 'adapter' },
      workspace: { root, packages: [adapterPackage, extraPackage] },
    };

    const missingSchema = await runCheck(payload);
    assertIssue(missingSchema, '@fixture/adapter', 'configSchema', 'dist/manifest.js');

    await writeFile(path.join(adapterRoot, 'dist', 'manifest.js'), adapterManifest({ implements: 'IFixture', configSchema: {}, networkRequired: undefined }));
    const missingNetworkRequirement = await runCheck(payload);
    assertIssue(missingNetworkRequirement, '@fixture/adapter', 'networkRequired', 'dist/manifest.js');

    await writeFile(path.join(adapterRoot, 'dist', 'manifest.js'), adapterManifest({ implements: 'IFixture', configSchema: {} }));
    const outsideCategory = await runCheck(payload);
    assertIssue(outsideCategory, '@fixture/extra', 'outside the devkit adapter category', 'package.json');

    extraPackage.category = 'adapter';
    await writeFile(path.join(extraRoot, 'dist', 'manifest.js'), adapterManifest({ configSchema: {} }));
    const undiscoverableCategory = await runCheck(payload);
    assertIssue(undiscoverableCategory, '@fixture/extra', 'not discoverable by platform adapter discovery', 'package.json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest declaration check rejects a default-only manifest module', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kb-named-manifest-check-'));
  try {
    const packageRoot = path.join(root, 'packages', 'default-only');
    await writeFixturePackage(packageRoot, '@fixture/default-only', adapterManifest({ implements: 'IFixture', configSchema: {} }));
    await writeFile(path.join(packageRoot, 'dist', 'manifest.js'), 'export default { schema: "kb.plugin/3" };\n');
    const pkg = { name: '@fixture/default-only', dir: packageRoot, relPath: 'packages/default-only', category: 'ts-lib', language: 'typescript' };
    const issues = await runCheck({
      workspaceRoot: root, check: 'adapter-manifest',
      package: { Name: pkg.name, Dir: packageRoot, RelPath: pkg.relPath, Category: pkg.category },
      workspace: { root, packages: [pkg] },
    });
    assertIssue(issues, pkg.name, 'must export an object named manifest', 'manifest.js');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeFixturePackage(packageRoot, name, manifest) {
  await mkdir(path.join(packageRoot, 'dist'), { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    type: 'module',
    kb: {
      manifest: './dist/manifest.js',
      adapter: { manifest: './dist/manifest.js' },
    },
  }));
  await writeFile(path.join(packageRoot, 'dist', 'manifest.js'), manifest);
}

function adapterManifest(fields) {
  return `export const manifest = ${JSON.stringify({
    schema: 'kb.adapter/1', manifestVersion: '1.0.0', id: 'fixture', name: 'Fixture', version: '1.0.0', type: 'core', networkRequired: true, ...fields,
  })};\n`;
}

async function runCheck(input) {
  const result = runExternalCheck(checker, [], {
    cwd: path.dirname(checker),
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.result.issues;
}

function assertIssue(issues, packageName, message, file) {
  const issue = issues.find(candidate => candidate.message.includes(packageName) && candidate.message.includes(message));
  assert.ok(issue, `missing issue ${packageName}: ${message}; got ${JSON.stringify(issues)}`);
  assert.ok(issue.file.endsWith(file), `issue file ${issue.file} does not end with ${file}`);
}
