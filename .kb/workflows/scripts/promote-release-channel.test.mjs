import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createCandidateBundle } from '../../../plugins/release/dist/shared/candidate-bundle.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
let moduleBuild = 0;

function copyScratchRelease(temp, policyText) {
  const packageRoot = join(temp, 'plugins/release');
  const sourceRoot = join(packageRoot, 'src');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ type: 'module' }));
  mkdirSync(join(sourceRoot, 'core'), { recursive: true });
  mkdirSync(join(sourceRoot, 'shared'), { recursive: true });
  writeFileSync(join(sourceRoot, 'core/platform-flow-policy.mjs'), policyText);
  cpSync(resolve(root, 'plugins/release/src/core/delivery-policy.ts'), join(sourceRoot, 'core/delivery-policy.ts'));
  cpSync(resolve(root, 'plugins/release/src/shared/candidate-bundle.ts'), join(sourceRoot, 'shared/candidate-bundle.ts'));
  const built = spawnSync(resolve(root, 'node_modules/.bin/tsup'), [
    'src/shared/candidate-bundle.ts', '--format', 'esm', '--platform', 'node', '--out-dir', 'dist/shared', '--no-splitting',
  ], { cwd: packageRoot, encoding: 'utf8' });
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  return {
    packageRoot,
    policyPath: join(sourceRoot, 'core/platform-flow-policy.mjs'),
    verifierPath: join(packageRoot, 'dist/shared/candidate-bundle.js'),
  };
}

async function makeScratchBundle(verifierPath, temp, gate, channel = 'stable', candidateId = 'stable-candidate') {
  const { createCandidateBundle } = await import(`${pathToFileURL(verifierPath).href}?build=${moduleBuild++}`);
  const source = join(temp, 'source');
  mkdirSync(source, { recursive: true });
  const tarball = 'kb-labs-fixture-1.0.0.tgz';
  const bytes = 'fixture';
  writeFileSync(join(source, tarball), bytes);
  writeFileSync(join(source, 'manifest.json'), JSON.stringify([{
    name: '@kb-labs/fixture', version: '1.0.0', tarball,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }]));
  const indexPath = join(temp, 'release-index.json');
  writeFileSync(indexPath, JSON.stringify({ platforms: [{ id: 'platform', version: '1.0.0' }] }));
  const bundle = join(temp, `${channel}-bundle`);
  const provenance = createCandidateBundle({
    candidateId, commit: '1234567890123456789012345678901234567890',
    flow: 'platform', version: '1.0.0', channel, gate, workflowRunId: '1234',
    artifactsDir: source, releaseIndexPath: indexPath, outputDir: bundle,
  });
  return { bundle, provenance };
}

test('delivery and promotion follow the scratch declaration for stable gate and target policy', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'x245-policy-mutation-'));
  try {
    const originalPolicy = readFileSync(resolve(root, 'plugins/release/src/core/platform-flow-policy.mjs'), 'utf8');
    const ungatedPolicy = originalPolicy
      .replace("stable: { policy: 'release-cases' }", "stable: { policy: 'none' }")
      .replace("stable: 'npm'", "stable: 'local'");
    assert.notEqual(ungatedPolicy, originalPolicy, 'scratch mutation must change stable gate and target declarations');
    const scratch = copyScratchRelease(temp, ungatedPolicy);
    const skipped = await makeScratchBundle(scratch.verifierPath, temp, { policy: 'none', result: 'skipped' });
    const verifierUrl = `${pathToFileURL(scratch.verifierPath).href}?build=${moduleBuild++}`;
    let { verifyCandidateBundle } = await import(verifierUrl);
    const trust = {
      candidateId: 'stable-candidate', commit: skipped.provenance.commit, flow: 'platform',
      version: '1.0.0', expectedDigest: skipped.provenance.bundleDigest,
    };
    assert.doesNotThrow(() => verifyCandidateBundle(skipped.bundle, trust, { targetKind: 'test' }));
    assert.throws(
      () => verifyCandidateBundle(skipped.bundle, trust, { targetKind: 'public' }),
      /Public delivery requires a channel with a passed release-case gate/,
    );

    const gatedPolicy = ungatedPolicy.replace("stable: { policy: 'none' }", "stable: { policy: 'release-cases' }");
    writeFileSync(scratch.policyPath, gatedPolicy);
    const rebuilt = spawnSync(resolve(root, 'node_modules/.bin/tsup'), [
      'src/shared/candidate-bundle.ts', '--format', 'esm', '--platform', 'node', '--out-dir', 'dist/shared', '--no-splitting',
    ], { cwd: scratch.packageRoot, encoding: 'utf8' });
    assert.equal(rebuilt.status, 0, `${rebuilt.stdout}\n${rebuilt.stderr}`);
    ({ verifyCandidateBundle } = await import(`${pathToFileURL(scratch.verifierPath).href}?build=${moduleBuild++}`));
    assert.throws(
      () => verifyCandidateBundle(skipped.bundle, trust, { targetKind: 'test' }),
      /gate policy differs from the release flow declaration/,
    );

    const scriptDir = join(temp, '.kb/workflows/scripts');
    mkdirSync(scriptDir, { recursive: true });
    const promotionScript = join(scriptDir, 'promote-release-channel.mjs');
    cpSync(resolve(root, '.kb/workflows/scripts/promote-release-channel.mjs'), promotionScript);
    const fakeBin = join(temp, 'bin');
    mkdirSync(fakeBin);
    const gh = join(fakeBin, 'gh');
    writeFileSync(gh, `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='run'&&args[1]==='download'){fs.cpSync(process.env.PROMOTION_FIXTURE,args[args.indexOf('--dir')+1],{recursive:true});process.exit(0)}if(args[0]==='release')process.exit(0);process.exit(2)\n`);
    chmodSync(gh, 0o755);
    const npm = join(fakeBin, 'npm');
    writeFileSync(npm, '#!/usr/bin/env node\nif(process.argv.includes("view"))process.stdout.write("{}\\n");\n');
    chmodSync(npm, 0o755);
    const pnpm = join(fakeBin, 'pnpm');
    writeFileSync(pnpm, '#!/bin/sh\nexit 0\n');
    chmodSync(pnpm, 0o755);
    const promoted = spawnSync(process.execPath, [promotionScript,
      '--candidate-run-id', '17', '--candidate-id', 'stable-candidate', '--flow', 'platform',
      '--version', '1.0.0', '--channel', 'stable', '--commit', skipped.provenance.commit,
      '--expected-digest', skipped.provenance.bundleDigest,
    ], {
      cwd: temp,
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PROMOTION_FIXTURE: skipped.bundle,
        NPM_TOKEN: 'test-token', GITHUB_REPOSITORY: 'fixture/repo',
      },
    });
    assert.notEqual(promoted.status, 0);
    assert.match(`${promoted.stdout}${promoted.stderr}`, /gate policy differs from the release flow declaration/);
    assert.doesNotMatch(promoted.stdout, /"promoted":true/);

    const canary = await makeScratchBundle(scratch.verifierPath, temp, { policy: 'none', result: 'skipped' }, 'canary', 'canary-candidate');
    const canaryPromotion = spawnSync(process.execPath, [promotionScript,
      '--candidate-run-id', '18', '--candidate-id', 'canary-candidate', '--flow', 'platform',
      '--version', '1.0.0', '--channel', 'stable', '--commit', canary.provenance.commit,
      '--expected-digest', canary.provenance.bundleDigest,
    ], {
      cwd: temp,
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PROMOTION_FIXTURE: canary.bundle,
        NPM_TOKEN: 'test-token', GITHUB_REPOSITORY: 'fixture/repo',
      },
    });
    assert.notEqual(canaryPromotion.status, 0);
    assert.match(`${canaryPromotion.stdout}${canaryPromotion.stderr}`, /Candidate channel canary does not match promotion channel stable/);
    assert.doesNotMatch(canaryPromotion.stdout, /"promoted":true/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('promotion refuses a canary candidate when the requested channel is stable', () => {
  const temp = mkdtempSync(join(tmpdir(), 'x245-promote-test-'));
  try {
    const source = join(temp, 'source');
    mkdirSync(source);
    const tarball = 'kb-labs-fixture-1.0.0.tgz';
    const bytes = 'fixture';
    writeFileSync(join(source, tarball), bytes);
    writeFileSync(join(source, 'manifest.json'), JSON.stringify([{
      name: '@kb-labs/fixture',
      version: '1.0.0',
      tarball,
      sha256: 'sha256-placeholder',
    }]));
    const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
    manifest[0].sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest));
    const indexPath = join(temp, 'release-index.json');
    writeFileSync(indexPath, JSON.stringify({ platforms: [{ id: 'platform', version: '1.0.0' }] }));
    const bundle = join(temp, 'bundle');
    const provenance = createCandidateBundle({
      candidateId: 'test-candidate',
      commit: '1234567890123456789012345678901234567890',
      flow: 'platform',
      version: '1.0.0',
      channel: 'canary',
      gate: { policy: 'none', result: 'skipped' },
      workflowRunId: '1234',
      artifactsDir: source,
      releaseIndexPath: indexPath,
      outputDir: bundle,
    });
    const fakeBin = join(temp, 'bin');
    mkdirSync(fakeBin);
    const gh = join(fakeBin, 'gh');
    writeFileSync(gh, `#!/usr/bin/env node\nconst fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);if(args[0]==='run'&&args[1]==='download'){const dir=args[args.indexOf('--dir')+1];fs.cpSync(process.env.PROMOTION_FIXTURE,dir,{recursive:true});process.exit(0)}if(args[0]==='release')process.exit(0);process.exit(2)\n`);
    chmodSync(gh, 0o755);
    const npm = join(fakeBin, 'npm');
    writeFileSync(npm, '#!/usr/bin/env node\nif(process.argv.includes("view"))process.stdout.write("{\\"latest\\":\\"1.0.0\\"}\\n");\n');
    chmodSync(npm, 0o755);
    const pnpm = join(fakeBin, 'pnpm');
    writeFileSync(pnpm, '#!/bin/sh\nexit 0\n');
    chmodSync(pnpm, 0o755);

    const script = resolve(root, '.kb/workflows/scripts/promote-release-channel.mjs');
    const result = spawnSync(process.execPath, [script,
      '--candidate-run-id', '17', '--candidate-id', 'test-candidate', '--flow', 'platform',
      '--version', '1.0.0', '--channel', 'stable', '--commit', provenance.commit,
      '--expected-digest', provenance.bundleDigest,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        PROMOTION_FIXTURE: bundle,
        NPM_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'fixture/repo',
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /Candidate channel canary does not match promotion channel stable/);
    assert.doesNotMatch(result.stdout, /"promoted":true/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
