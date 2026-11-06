import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseNodeEnginePolicy, readNodeEngineDeclaration } from '../../core/plugin-contracts/src/node-engine-policy.mjs';
import { parseDockerfileFromInstructions } from './node-engine-dockerfiles.mjs';
import { inspectPrebuildImportGraph } from './prebuild-imports.mjs';
import { checkAuthoredEsmDeclarationDrift } from './authored-esm-declarations.mjs';
import { runExternalCheck } from './lib/run-external-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checker = path.join(root, 'scripts/checks/check-node-engine-policy.mjs');
const generator = path.join(root, 'tools/clikit/toolchain/generate-node-policy.mjs');
const devkitModule = path.join(root, 'tools/kb-devkit');
const realDockerfileStatusBeforeTests = dockerfileWorktreeStatus();

test('authored ESM declaration drift names the stale file and regenerate command', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-authored-esm-drift-'));
  try {
    const packageRoot = path.join(fixtureRoot, 'fixture-package');
    const sourceRoot = path.join(packageRoot, 'src');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@fixture/contracts',
      exports: {
        './policy': {
          types: './src/policy.d.mts',
          import: './src/policy.mjs',
        },
      },
    }));
    await writeFile(path.join(packageRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { rootDir: 'src' },
      include: ['src'],
    }));
    await writeFile(path.join(sourceRoot, 'policy.mjs'), [
      '/**',
      ' * @param {string} value',
      ' * @returns {string}',
      ' */',
      'export function normalize(value) { return value.trim(); }',
      '',
    ].join('\n'));
    await writeFile(path.join(sourceRoot, 'policy.d.mts'), 'export declare function normalize(value: number): string;\n');

    const issues = await checkAuthoredEsmDeclarationDrift([{ name: '@fixture/contracts', dir: packageRoot }], root);

    assert.equal(issues.length, 1);
    assert.equal(issues[0].file, path.join(sourceRoot, 'policy.d.mts'));
    assert.match(issues[0].message, /corepack pnpm exec node scripts\/checks\/generate-authored-esm-declarations\.mjs/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

// case: S-261.8
test('Node engine selector runs in a fresh checkout before package builds', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-node-selector-no-dist-'));
  try {
    const runtimeDirectory = path.join(fixtureRoot, 'core/plugin-runtime/src/platform-resolve');
    const packageDirectory = path.join(fixtureRoot, 'core/plugin-runtime/node_modules/@kb-labs/plugin-contracts');
    await mkdir(runtimeDirectory, { recursive: true });
    await mkdir(path.join(packageDirectory, 'src'), { recursive: true });
    await writeFile(path.join(fixtureRoot, 'package.json'), JSON.stringify({ engines: { node: '24.x' } }));
    await writeFile(path.join(runtimeDirectory, 'node-engine.mjs'), await readFile(path.join(root, 'core/plugin-runtime/src/platform-resolve/node-engine.mjs')));
    await writeFile(path.join(packageDirectory, 'package.json'), await readFile(path.join(root, 'core/plugin-contracts/package.json')));
    await writeFile(path.join(packageDirectory, 'src/node-engine-policy.mjs'), await readFile(path.join(root, 'core/plugin-contracts/src/node-engine-policy.mjs')));

    const result = spawnSync(process.execPath, [path.join(runtimeDirectory, 'node-engine.mjs'), '--required-major', path.join(fixtureRoot, 'package.json')], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '24');
    assert.deepEqual(inspectPrebuildImportGraph(path.join(runtimeDirectory, 'node-engine.mjs'), fixtureRoot), []);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('pre-build import rail reports resolved build-output dependencies', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-node-selector-build-import-'));
  try {
    const entry = path.join(fixtureRoot, 'selector.mjs');
    await mkdir(path.join(fixtureRoot, 'node_modules/@fixture/contracts/dist'), { recursive: true });
    await writeFile(entry, "import { policy } from '@fixture/contracts';\nvoid policy;\n");
    await writeFile(path.join(fixtureRoot, 'node_modules/@fixture/contracts/package.json'), JSON.stringify({ exports: { '.': './dist/policy.mjs' } }));
    await writeFile(path.join(fixtureRoot, 'node_modules/@fixture/contracts/dist/policy.mjs'), 'export const policy = 24;\n');

    assert.deepEqual(inspectPrebuildImportGraph(entry, fixtureRoot), [
      { file: entry, specifier: '@fixture/contracts', resolved: path.join(fixtureRoot, 'node_modules/@fixture/contracts/dist/policy.mjs') },
    ]);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('pre-build import rail reports dependencies resolved outside the workspace', async () => {
  const fixtureParent = await mkdtemp(path.join(os.tmpdir(), 'kb-node-selector-outside-import-'));
  try {
    const workspaceRoot = path.join(fixtureParent, 'workspace');
    const entry = path.join(workspaceRoot, 'selector.mjs');
    const externalModule = path.join(fixtureParent, 'external.mjs');
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(entry, `import ${JSON.stringify(externalModule)};\n`);
    await writeFile(externalModule, 'export {};\n');

    assert.deepEqual(inspectPrebuildImportGraph(entry, workspaceRoot), [
      { file: entry, specifier: externalModule, resolved: externalModule },
    ]);
  } finally {
    await rm(fixtureParent, { recursive: true, force: true });
  }
});

// case: S-260.2
test('the shipped Node policy passes the workspace check', () => {
  const result = runDevkitCheck();

  const diagnostics = [result.stdout, result.stderr].filter(Boolean).join('\n');
  assert.equal(result.status, 0, diagnostics || 'kb-devkit check exited without diagnostics');
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true, JSON.stringify(report.issues ?? report, null, 2));
});

test('node-engine-policy check diagnoses missing external-check input', () => {
  const result = spawnSync(process.execPath, [checker], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires workspace input on stdin; next: kb-devkit check --only node-engine-policy --json/);
  assert.doesNotMatch(result.stderr, /SyntaxError|Unexpected end of JSON/);
});

test('workspace engine policy names every package whose declaration differs', async () => {
  const workspaceRoot = await fixtureWorkspace('24.x');
  try {
    const generated = spawnSync(process.execPath, [generator, '--root', workspaceRoot], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    await writePackage(workspaceRoot, 'packages/matching', '@fixture/matching', '24.x');
    await writePackage(workspaceRoot, 'packages/mismatch', '@fixture/mismatch', '26.x');
    const result = runCheck(workspaceRoot, [
      packageRecord(workspaceRoot, 'packages/matching', '@fixture/matching'),
      packageRecord(workspaceRoot, 'packages/mismatch', '@fixture/mismatch'),
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const issues = result.result.issues;
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /@fixture\/mismatch/);
    assert.match(issues[0].message, /26\.x/);
    assert.equal(issues[0].file, path.join(workspaceRoot, 'packages/mismatch/package.json'));
    assert.match(result.stderr, /node-engine-policy: .*@fixture\/mismatch.*26\.x/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('workspace engine policy rejects any root syntax other than MAJOR.x', async () => {
  const workspaceRoot = await fixtureWorkspace('^24.x');
  try {
    await writePackage(workspaceRoot, 'packages/declared', '@fixture/declared', '^24.x');
    const result = runCheck(workspaceRoot, [packageRecord(workspaceRoot, 'packages/declared', '@fixture/declared')]);

    assert.equal(result.exitCode, 0, result.stderr);
    const issues = result.result.issues;
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /Unsupported Node\.js engine declaration "\^24\.x"/);
    assert.equal(issues[0].file, path.join(workspaceRoot, 'package.json'));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

// case: S-260.3
test('generated Go Node policy matches the owner and rejects root-owner drift', async () => {
  const workspaceRoot = await fixtureWorkspace('24.x');
  try {
    await writePackage(workspaceRoot, 'packages/declared', '@fixture/declared', '24.x');
    const generatedResult = spawnSync(process.execPath, [generator, '--root', workspaceRoot], { encoding: 'utf8' });
    assert.equal(generatedResult.status, 0, generatedResult.stderr);

    const rootManifestPath = path.join(workspaceRoot, 'package.json');
    const rootManifest = JSON.parse(await readFile(rootManifestPath, 'utf8'));
    rootManifest.engines.node = '26.x';
    await writeFile(rootManifestPath, JSON.stringify(rootManifest));
    const packageManifestPath = path.join(workspaceRoot, 'packages/declared/package.json');
    const packageManifest = JSON.parse(await readFile(packageManifestPath, 'utf8'));
    packageManifest.engines.node = '26.x';
    await writeFile(packageManifestPath, JSON.stringify(packageManifest));
    const ownerDrift = runCheck(workspaceRoot, [packageRecord(workspaceRoot, 'packages/declared', '@fixture/declared')]);
    assert.equal(ownerDrift.exitCode, 0, ownerDrift.stderr);
    assert.match(ownerDrift.result.issues.map(({ message }) => message).join('\n'), /generated Go Node policy is stale/);

  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('generated Node image contract follows the policy owner and detects JSON drift', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-node-policy-image-'));
  try {
    await writeFile(path.join(fixtureRoot, 'package.json'), JSON.stringify({
      engines: { node: '26.x' }, packageManager: 'pnpm@11.5.0',
    }));
    const generated = spawnSync(process.execPath, [generator, '--root', fixtureRoot], {
      cwd: root, encoding: 'utf8',
    });
    assert.equal(generated.status, 0, generated.stderr);
    const declaration = await readNodeEngineDeclaration(path.join(fixtureRoot, 'package.json'));
    const major = parseNodeEnginePolicy(declaration).requiredMajor;
    const policyPath = path.join(fixtureRoot, 'tools/clikit/toolchain/node_policy_gen.json');
    const policy = JSON.parse(await readFile(policyPath, 'utf8'));
    assert.equal(policy.requiredMajor, major);
    assert.equal(policy.nodeBaseImage, `node:${major}-bookworm`);
    assert.ok(policy.nodeBaseImageArgument);

    const current = spawnSync(process.execPath, [generator, '--check', '--root', fixtureRoot], {
      cwd: root, encoding: 'utf8',
    });
    assert.equal(current.status, 0, current.stderr);
    policy.nodeBaseImage = 'node:24-bookworm';
    await writeFile(policyPath, JSON.stringify(policy, null, 2) + '\n');
    const stale = spawnSync(process.execPath, [generator, '--check', '--root', fixtureRoot], {
      cwd: root, encoding: 'utf8',
    });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /generated JSON Node policy is stale/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('Go compilation rejects a duplicate generated node policy constant in an isolated package', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-node-policy-duplicate-'));
  try {
    const generatedSource = await readFile(path.join(root, 'tools/clikit/toolchain/node_policy_gen.go'), 'utf8');
    await writeFile(path.join(fixtureRoot, 'go.mod'), 'module fixture\n\ngo 1.22\n');
    await writeFile(path.join(fixtureRoot, 'node_policy_gen.go'), generatedSource);
    await writeFile(path.join(fixtureRoot, 'handwritten.go'), generatedSource);
    const result = spawnSync('go', ['test', './...'], { cwd: fixtureRoot, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /SupportedNodeMajor redeclared|already declared/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

// case: S-260.5
test('tracked Node image with the matching policy tag passes', async (t) => {
  const declaration = readNodeEngineDeclaration(path.join(root, 'package.json'));
  const requiredMajor = parseNodeEnginePolicy(declaration).requiredMajor;
  const { repositoryRoot } = await createTrackedDockerfileRepo(t, `FROM node:${requiredMajor}-slim AS runner\n`);
  const result = runCheck(repositoryRoot, []);
  assert.deepEqual(result.result.issues, []);
});

// case: S-260.5
test('tracked Node image with a mismatched tag fails with file and line', async (t) => {
  const declaration = readNodeEngineDeclaration(path.join(root, 'package.json'));
  const requiredMajor = parseNodeEnginePolicy(declaration).requiredMajor;
  const unsupportedMajor = requiredMajor + 2;
  const { repositoryRoot } = await createTrackedDockerfileRepo(t, `FROM node:${unsupportedMajor}-slim AS runner\n`);
  const issues = runCheck(repositoryRoot, []).result.issues;

  assert.equal(issues.length, 1);
  assert.equal(issues[0].file, 'Dockerfile:1');
  assert.match(issues[0].message, new RegExp(`Node ${unsupportedMajor}`));
});

// case: S-260.5
test('tracked Node image with an unresolved ARG fails with file and line', async (t) => {
  const { repositoryRoot } = await createTrackedDockerfileRepo(t, 'FROM node:${X} AS runner\n');
  const issues = runCheck(repositoryRoot, []).result.issues;

  assert.equal(issues.length, 1);
  assert.equal(issues[0].file, 'Dockerfile:1');
  assert.match(issues[0].message, /undeclared ARG or variable/);
});

// case: S-260.5
test('Dockerfile parsing preserves declared external base arguments', () => {
  const source = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE} AS runner\n';
  const parsed = parseDockerfileFromInstructions(source);
  assert.deepEqual(parsed, [{ line: 2, externalImage: '${BASE_IMAGE}', externalArgs: ['BASE_IMAGE'], stage: 'runner' }]);
});

// case: S-260.5
test('a declared external FROM ARG is refused unless it consumes the derived runner toolchain image', async (t) => {
  const declaration = readNodeEngineDeclaration(path.join(root, 'package.json'));
  const requiredMajor = parseNodeEnginePolicy(declaration).requiredMajor;
  const { repositoryRoot } = await createTrackedDockerfileRepo(
    t,
    `ARG KB_JOURNEY_TOOLCHAIN_IMAGE\nARG BASE_IMAGE\nFROM node:${requiredMajor}-bookworm AS toolchain\nFROM \${BASE_IMAGE}\n`,
    'e2e/journey/Dockerfile.runner',
  );
  const result = runCheck(repositoryRoot, []);
  const issues = result.result.issues;

  assert.equal(issues.length, 1);
  assert.equal(issues[0].file, 'e2e/journey/Dockerfile.runner:4');
  assert.match(issues[0].message, /not derived from the checked runner toolchain stage/);
});

// case: S-260.5
test('tracked Node image resolves a declared global ARG default', async (t) => {
  const declaration = readNodeEngineDeclaration(path.join(root, 'package.json'));
  const requiredMajor = parseNodeEnginePolicy(declaration).requiredMajor;
  const { repositoryRoot } = await createTrackedDockerfileRepo(
    t,
    `ARG NODE_MAJOR=${requiredMajor}\nFROM node:\${NODE_MAJOR}-slim \\\n  AS runner\n`,
  );
  assert.deepEqual(runCheck(repositoryRoot, []).result.issues, []);
});

test('Dockerfile cases leave real-worktree Dockerfile status unchanged', () => {
  assert.equal(dockerfileWorktreeStatus(), realDockerfileStatusBeforeTests);
});

async function fixtureWorkspace(policy) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-node-engine-policy-'));
  await writePackage(workspaceRoot, '.', '@fixture/root', policy);
  await setWorkspacePackageManager(workspaceRoot);
  await initializeTemporaryGit(workspaceRoot, ['package.json']);
  return workspaceRoot;
}

async function createTrackedDockerfileRepo(t, dockerfile, dockerfilePath = 'Dockerfile') {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-node-docker-policy-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const declaration = readNodeEngineDeclaration(path.join(root, 'package.json'));
  const workspacePackageManager = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).packageManager;
  await writeFile(path.join(repositoryRoot, 'package.json'), JSON.stringify({ packageManager: workspacePackageManager, engines: { node: declaration } }));
  const dockerfileFullPath = path.join(repositoryRoot, dockerfilePath);
  await mkdir(path.dirname(dockerfileFullPath), { recursive: true });
  await writeFile(dockerfileFullPath, dockerfile);
  await initializeTemporaryGit(repositoryRoot, ['package.json', dockerfilePath]);
  const generated = spawnSync(process.execPath, [generator, '--root', repositoryRoot], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);

  return {
    repositoryRoot,
    requiredMajor: parseNodeEnginePolicy(declaration).requiredMajor,
  };
}

async function setWorkspacePackageManager(workspaceRoot) {
  const sourceManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const fixtureManifestPath = path.join(workspaceRoot, 'package.json');
  const fixtureManifest = JSON.parse(await readFile(fixtureManifestPath, 'utf8'));
  fixtureManifest.packageManager = sourceManifest.packageManager;
  await writeFile(fixtureManifestPath, JSON.stringify(fixtureManifest));
}

async function initializeTemporaryGit(repositoryRoot, files) {
  for (const args of [['init', '--quiet'], ['add', '--', ...files]]) {
    const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
}

function dockerfileWorktreeStatus() {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '*Dockerfile*'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

async function writePackage(workspaceRoot, relativePath, name, policy) {
  const packageRoot = path.resolve(workspaceRoot, relativePath);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name,
    engines: { node: policy },
  }));
}

function packageRecord(workspaceRoot, relativePath, name) {
  return { name, dir: path.resolve(workspaceRoot, relativePath) };
}

function runCheck(workspaceRoot, packages) {
  return runExternalCheck(checker, [], {
    cwd: workspaceRoot,
    input: JSON.stringify({
      check: 'node-engine-policy',
      workspaceRoot,
      workspace: { packages },
    }),
    encoding: 'utf8',
  });
}

function runDevkitCheck() {
  return spawnSync('go', ['-C', devkitModule, 'run', '.', 'check', '--only', 'node-engine-policy', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
}
