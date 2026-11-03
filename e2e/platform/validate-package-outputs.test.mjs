import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildCommand, failureMessage, inspectPackedFixture, validatePackageContents, validatePackedSource, validateTarballAgainstWorkspace, validateReleaseBuildOutputs, validateWorkspacePackageContents } from './validate-package-outputs.mjs';
import registryManifest from './registry-manifest.json' with { type: 'json' };
import { readPlatformReleaseConfig, releaseArtifactPackageNames } from 'kb-create/scripts/platform-release-config.mjs';

test('rejects a packed manifest that diverges from the source package manifest', () => {
  const source = {
    name: '@kb-labs/qa',
    version: '2.120.1',
    dependencies: { '@kb-labs/sdk': 'workspace:*' },
  };
  const packed = {
    name: '@kb-labs/qa',
    version: '2.120.1',
    dependencies: { '@kb-labs/sdk': '2.120.1' },
  };
  const errors = validatePackedSource(source, packed, {
    sourcePackedPackage: packed,
    sourceManifest: { commands: [{ flags: ['run-id', 'exclude-job'] }] },
    packedManifest: { commands: [{ flags: ['runId', 'excludeJob'] }] },
    workspacePackageNames: new Set(['@kb-labs/qa', '@kb-labs/sdk']),
    candidateNames: new Set(['@kb-labs/qa', '@kb-labs/sdk']),
  });

  assert.deepEqual(errors, [
    'dist/manifest.json differs from the workspace build output',
  ]);
});

test('rejects a packed dependency closure pinned to a different workspace version', () => {
  const source = {
    name: '@kb-labs/mind',
    version: '2.120.1',
    dependencies: { '@kb-labs/sdk': 'workspace:*' },
  };
  const packed = {
    name: '@kb-labs/mind',
    version: '2.120.1',
    dependencies: { '@kb-labs/sdk': '2.117.0' },
  };

  assert.deepEqual(validatePackedSource(source, packed, {
    sourcePackedPackage: { ...packed, dependencies: { '@kb-labs/sdk': '2.120.1' } },
    workspacePackageNames: new Set(['@kb-labs/mind', '@kb-labs/sdk']),
    candidateNames: new Set(['@kb-labs/mind', '@kb-labs/sdk']),
  }), [
    'package.json differs from the package freshly packed from workspace source',
  ]);
});

test('rejects a candidate missing an internal package required by a packed dependency', () => {
  const packageSource = {
    name: '@kb-labs/mind',
    version: '2.120.1',
    dependencies: { '@kb-labs/sdk': 'workspace:*' },
  };
  assert.deepEqual(validatePackedSource(packageSource, {
    name: '@kb-labs/mind',
    version: '2.120.1',
    dependencies: { '@kb-labs/sdk': '2.120.1' },
  }, {
    sourcePackedPackage: {
      name: '@kb-labs/mind',
      version: '2.120.1',
      dependencies: { '@kb-labs/sdk': '2.120.1' },
    },
    workspacePackageNames: new Set(['@kb-labs/mind', '@kb-labs/sdk']),
    candidateNames: new Set(['@kb-labs/mind']),
  }), [
    'dependencies.@kb-labs/sdk is required from the workspace but missing from the candidate package set',
  ]);
});

test('requires declared build outputs and every main/export target to be packed', () => {
  const manifest = {
    name: '@kb-labs/example',
    files: ['dist', 'README.md'],
    main: './dist/index.js',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
  };
  const failures = validatePackageContents(manifest, [
    'package/package.json', 'package/README.md', 'package/dist/index.js',
  ]);
  assert.deepEqual(failures, [
    { field: 'exports', target: './dist/index.d.ts' },
  ]);
});

test('release preflight requires dist even when files is only an npm inclusion filter', t => {
  const root = mkdtempSync(join(tmpdir(), 'kb-release-dist-required-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDirectory = join(root, 'packages/example');
  mkdirSync(packageDirectory, { recursive: true });
  const manifest = { name: '@kb-labs/example', files: ['dist'] };
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify(manifest));
  const failures = validateReleaseBuildOutputs(new Map([
    [manifest.name, { directory: packageDirectory, manifest }],
  ]), { core: [{ name: manifest.name }] }, []);
  assert.deepEqual(failures, [{
    packageName: manifest.name,
    message: 'ERROR: @kb-labs/example is missing required release output dist before packing. ' +
      'Build it with: corepack pnpm -r --filter "@kb-labs/example..." --workspace-concurrency=2 build',
  }]);
});

test('requires Studio to pack dist/index.html and reports its exact dependency build command', () => {
  const manifest = {
    name: '@kb-labs/studio-app',
    files: ['dist'],
    main: './dist/index.js',
    kb: { requiredOutputs: ['./dist/index.html'] },
  };
  const failures = validatePackageContents(manifest, [
    'package/package.json', 'package/dist/index.js',
  ]);
  assert.deepEqual(failures, [{ field: 'kb.requiredOutputs', target: './dist/index.html' }]);
  assert.equal(
    buildCommand(manifest.name),
    'corepack pnpm -r --filter "@kb-labs/studio-app..." --workspace-concurrency=2 build',
  );
  assert.equal(
    failureMessage(manifest, '/tmp/kb-labs-studio-app-2.0.0.tgz', failures[0]),
    'ERROR: @kb-labs/studio-app (kb-labs-studio-app-2.0.0.tgz) is missing packed kb.requiredOutputs output ./dist/index.html. ' +
      'Build it with: corepack pnpm -r --filter "@kb-labs/studio-app..." --workspace-concurrency=2 build',
  );
});

test('matches declared build-output globs against the packed paths', () => {
  const failures = validatePackageContents(
    { name: '@kb-labs/example', files: ['dist/**/*.js'] },
    ['package/package.json', 'package/dist/commands/run.js'],
  );
  assert.deepEqual(failures, []);
});

test('runs packed journey plugin manifests through product discovery and resolves every handler', async () => {
  const fixture = new URL('../journey/fixtures/analytics-emitter/', import.meta.url);
  const output = mkdtempSync(join(tmpdir(), 'kb-candidate-fixture-test-'));
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', output, '--silent'], { cwd: fixture, stdio: 'ignore' });
    const [archive] = readdirSync(output).filter((filename) => filename.endsWith('.tgz'));
    assert.ok(archive, 'pnpm pack produced the journey fixture tarball');
    const archivePath = join(output, archive);
    const unpacked = output;
    execFileSync('tar', ['-xzf', archivePath, '-C', output]);
    execFileSync('node', [
      new URL('../../infra/devkit/tsup/emit-manifest-json.mjs', import.meta.url).pathname,
      '--module', new URL('../journey/fixtures/analytics-emitter/manifest.js', import.meta.url).pathname,
      '--output', join(unpacked, 'package/dist/manifest.json'),
    ], { stdio: 'ignore' });
    const rebuilt = join(output, 'rebuilt.tgz');
    execFileSync('tar', ['-czf', rebuilt, '-C', unpacked, 'package']);
    renameSync(rebuilt, archivePath);
    const result = await inspectPackedFixture(archivePath);
    assert.equal(result.kind, 'plugin');
    assert.deepEqual(result.failures, []);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('rejects the packed pre-fix plugin layout through product handler resolution', async () => {
  const fixture = new URL('../journey/fixtures/analytics-emitter/', import.meta.url);
  const output = mkdtempSync(join(tmpdir(), 'kb-candidate-broken-layout-'));
  try {
    const source = join(output, 'source');
    cpSync(fixture, source, { recursive: true });
    cpSync(join(source, 'dist/commands'), join(source, 'commands'), { recursive: true });
    rmSync(join(source, 'dist/commands'), { recursive: true });
    const oldLayoutPackage = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    oldLayoutPackage.files = ['manifest.js', 'commands/*.js', 'dist/manifest.json'];
    oldLayoutPackage.kb = { manifest: oldLayoutPackage.kb.manifest };
    writeFileSync(join(source, 'package.json'), JSON.stringify(oldLayoutPackage));
    execFileSync('pnpm', ['pack', '--pack-destination', output, '--silent'], { cwd: source, stdio: 'ignore' });
    const [archiveName] = readdirSync(output).filter((filename) => filename.endsWith('.tgz'));
    assert.ok(archiveName, 'pnpm pack produced the pre-fix fixture tarball');
    const archive = join(output, archiveName);

    const result = await validateTarballAgainstWorkspace(
      archive,
      new Map([[oldLayoutPackage.name, { directory: source, manifest: oldLayoutPackage }]]),
      new Set(), new Set([oldLayoutPackage.name]), new Set([oldLayoutPackage.name]),
    );
    assert.equal(result.manifest.name, oldLayoutPackage.name);
    assert.ok(result.failures.some((failure) => failure.includes('@kb-labs/e2e-analytics-emitter')
      && failure.includes('./commands/emit.js#default')));
    assert.ok(result.failures.some((failure) => failure.includes('@kb-labs/e2e-analytics-emitter')
      && failure.includes('./commands/complete.js#default')));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('loads the packed deterministic adapter fixture through the product adapter loader', async () => {
  const fixture = new URL('../fixtures/adapters/llm-deterministic/', import.meta.url);
  const result = await inspectPackedFixture(fixture.pathname);
  assert.equal(result.kind, 'adapter');
  assert.equal(result.adapterManifest.id, 'e2e-llm-deterministic');
  assert.deepEqual(result.failures, []);
});

test('rejects a packed adapter fixture with an invalid adapter manifest', async () => {
  const fixture = new URL('../fixtures/adapters/llm-deterministic/', import.meta.url);
  const output = mkdtempSync(join(tmpdir(), 'kb-candidate-broken-adapter-'));
  try {
    const source = join(output, 'source');
    cpSync(fixture, source, { recursive: true });
    const manifest = readFileSync(join(source, 'manifest.js'), 'utf8')
      .replace("schema: 'kb.adapter/1'", "schema: 'kb.adapter/broken'");
    writeFileSync(join(source, 'manifest.js'), manifest);
    execFileSync('pnpm', ['pack', '--pack-destination', output, '--silent'], { cwd: source, stdio: 'ignore' });
    const [archive] = readdirSync(output).filter((filename) => filename.endsWith('.tgz'));
    assert.ok(archive, 'pnpm pack produced the broken adapter fixture tarball');
    const result = await inspectPackedFixture(join(output, archive));
    assert.equal(result.packageName, '@kb-labs/e2e-llm-deterministic');
    assert.equal(result.kind, 'invalid');
    assert.ok(result.failures.some((failure) => failure.includes('@kb-labs/e2e-llm-deterministic')
      && failure.includes('schema "kb.adapter/1"')));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});


test('preflight rejects missing declared workspace outputs before pnpm pack', () => {
  const manifest = {
    name: '@kb-labs/example',
    files: ['dist'],
    main: './dist/index.js',
  };
  const failures = validateWorkspacePackageContents(manifest, ['package.json', 'src/index.ts']);
  assert.deepEqual(failures, [{ field: 'main', target: './dist/index.js' }]);
  assert.equal(
    buildCommand(manifest.name),
    'corepack pnpm -r --filter "@kb-labs/example..." --workspace-concurrency=2 build',
  );
});

test('release package set excludes the source-only devkit tooling package', () => {
  const platformMembers = readPlatformReleaseConfig(fileURLToPath(new URL('../../tools/kb-create/config/platform-release.jsonc', import.meta.url))).platformMembers;
  assert.equal(releaseArtifactPackageNames(registryManifest, platformMembers).includes('@kb-labs/devkit'), false);
  assert.equal(releaseArtifactPackageNames(registryManifest, platformMembers).includes('@kb-labs/core-workspace'), true);
});


test('release build run preflight reports a missing dist output and exact package build command', t => {
  const root = mkdtempSync(join(tmpdir(), 'kb-release-build-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDirectory = join(root, 'packages/example');
  mkdirSync(packageDirectory, { recursive: true });
  const manifest = { name: '@kb-labs/example', files: ['dist'], main: './dist/index.js' };
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify(manifest));
  const failures = validateReleaseBuildOutputs(new Map([
    [manifest.name, { directory: packageDirectory, manifest }],
  ]), { core: [{ name: manifest.name }] }, []);
  assert.deepEqual(failures, [
    {
      packageName: manifest.name,
      message: 'ERROR: @kb-labs/example is missing required release output dist before packing. ' +
        'Build it with: corepack pnpm -r --filter "@kb-labs/example..." --workspace-concurrency=2 build',
    },
    {
      packageName: manifest.name,
      message: 'ERROR: @kb-labs/example is missing required main output ./dist/index.js before packing. ' +
        'Build it with: corepack pnpm -r --filter "@kb-labs/example..." --workspace-concurrency=2 build',
    },
  ]);
});

// case: S-262.1
test('devkit pack-extra build task emits the package-declared adapter manifest', () => {
  const fixture = new URL('../fixtures/adapters/llm-deterministic/', import.meta.url);
  execFileSync(process.execPath, [new URL('../scripts/build-pack-extra.mjs', import.meta.url).pathname], { cwd: fixture });
  const output = JSON.parse(readFileSync(new URL('../fixtures/adapters/llm-deterministic/dist/manifest.json', import.meta.url), 'utf8'));
  assert.equal(output.id, 'e2e-llm-deterministic');
  assert.equal(output.implements, 'ILLM');
});

test('every packed journey fixture is classified by the product plugin or adapter loader', async () => {
  const extras = JSON.parse(readFileSync(new URL('../scripts/pack-extras.json', import.meta.url), 'utf8'));
  for (const { directory } of extras) {
    const result = await inspectPackedFixture(new URL(`../../${directory}/`, import.meta.url).pathname.replace(/\/$/, ''));
    assert.ok(['plugin', 'adapter'].includes(result.kind), `${directory}: ${result.kind} ${result.failures.join('; ')}`);
    assert.deepEqual(result.failures, [], directory);
  }
});
