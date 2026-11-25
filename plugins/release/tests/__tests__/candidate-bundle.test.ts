import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createCandidateBundle, verifyCandidateBundle } from '../../src/shared/candidate-bundle.js';
import { stageSealedJourneyCandidate } from '../../src/shared/stage-sealed-journey-candidate.js';
import type { CandidateGateProvenance } from '../../src/core/delivery-policy.js';

let root: string;
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function resealLegacyProvenance(bundleDir: string): string {
  const provenancePath = join(bundleDir, 'provenance.json');
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as Record<string, unknown>;
  provenance.schema = 'kb.release-provenance/3';
  provenance.gate = { policy: 'release-cases', result: 'passed', runId: 'legacy-pre-build-journey' };
  const modesPath = join(bundleDir, 'bundle.modes');
  const modes = new Map(readFileSync(modesPath, 'utf8').trim().split(/\r?\n/).map(line => {
    const match = /^([0-7]{3,4})  \.\/(.+)$/.exec(line);
    if (!match) throw new Error(`Invalid mode entry: ${line}`);
    return [match[2]!, match[1]!];
  }));
  const files = [] as string[];
  const walk = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(bundleDir);
  const payload = files.filter(path => path !== 'provenance.json' && path !== 'bundle.sha256' && path !== 'bundle.modes')
    .sort().map(path => `${path}\0${modes.get(path)}\0${sha256(readFileSync(join(bundleDir, path)))}\n`).join('');
  const policyIdentity = JSON.stringify({
    schema: provenance.schema,
    candidateId: provenance.candidateId,
    commit: provenance.commit,
    flow: provenance.flow,
    version: provenance.version,
    channel: provenance.channel,
    workflowRunId: provenance.workflowRunId,
    gate: provenance.gate,
  });
  const bundleDigest = sha256(`${payload}\0${policyIdentity}\0${sha256(readFileSync(modesPath))}`);
  provenance.bundleDigest = bundleDigest;
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  writeFileSync(join(bundleDir, 'bundle.sha256'), `${files.filter(path => path !== 'bundle.sha256').sort()
    .map(path => `${sha256(readFileSync(join(bundleDir, path)))}  ./${path}\n`).join('')}`);
  return bundleDigest;
}

const identity = {
  candidateId: 'test-candidate',
  commit: '1234567890123456789012345678901234567890',
  flow: 'platform',
  version: '1.0.0',
};
const testPolicy = { targetKind: 'test' as const };

function writeSource(artifactsDir: string, tarball: string, tarballBytes: string, includeUnlistedNpmFile = false) {
  mkdirSync(artifactsDir);
  writeFileSync(join(artifactsDir, tarball), tarballBytes);
  writeFileSync(join(artifactsDir, 'manifest.json'), JSON.stringify([{
    name: '@kb-labs/fixture',
    version: '1.0.0',
    tarball,
    sha256: createHash('sha256').update(tarballBytes).digest('hex'),
  }]));
  if (includeUnlistedNpmFile) writeFileSync(join(artifactsDir, 'unlisted.tgz'), 'unexpected');
}

function makeBundle(
  includeUnlistedNpmFile = false,
  tarball = 'kb-labs-fixture-1.0.0.tgz',
  tarballBytes = 'fixture tarball bytes',
  channel: 'canary' | 'stable' = 'canary',
  gate: CandidateGateProvenance = { policy: 'none', result: 'skipped' },
) {
  root = mkdtempSync(join(tmpdir(), 'x241-candidate-'));
  const artifactsDir = join(root, 'source-artifacts');
  writeSource(artifactsDir, tarball, tarballBytes, includeUnlistedNpmFile);
  const releaseIndexPath = join(root, 'release-index.json');
  writeFileSync(releaseIndexPath, JSON.stringify({ platforms: [{ id: 'platform', version: '1.0.0' }] }));
  const bundleDir = join(root, 'bundle');
  const provenance = createCandidateBundle({
    ...identity,
    channel,
    gate,
    workflowRunId: '1234',
    artifactsDir,
    releaseIndexPath,
    outputDir: bundleDir,
  });
  return {
    bundleDir,
    tarballPath: join(bundleDir, 'npm', tarball),
    provenance,
    trust: { ...identity, expectedDigest: provenance.bundleDigest },
  };
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('candidate bundle producer and verifier', () => {
  // case: S-284.23
  it('stages the sealed npm tarball and binary bytes that the installer journey serves', async () => {
    root = mkdtempSync(join(tmpdir(), 'x241-sealed-journey-'));
    const sourceArtifacts = join(root, 'source-artifacts');
    mkdirSync(sourceArtifacts);
    const tarball = 'kb-labs-fixture-1.0.0.tgz';
    const packageDir = join(root, 'package/package');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@kb-labs/fixture', version: '1.0.0' }));
    const tarballPath = join(sourceArtifacts, tarball);
    execFileSync('tar', ['-czf', tarballPath, '-C', join(root, 'package'), 'package']);
    const tarballBytes = readFileSync(tarballPath);
    writeFileSync(join(sourceArtifacts, 'manifest.json'), JSON.stringify([{
      name: '@kb-labs/fixture',
      version: '1.0.0',
      tarball,
      sha256: createHash('sha256').update(tarballBytes).digest('hex'),
    }]));
    const binaryFilename = 'kb-create-linux-amd64';
    const binaryBytes = Buffer.from('sealed kb-create binary bytes');
    const binarySha = createHash('sha256').update(binaryBytes).digest('hex');
    const binariesDir = join(root, 'source-binaries');
    mkdirSync(join(binariesDir, 'nested'), { recursive: true });
    writeFileSync(join(binariesDir, 'nested', binaryFilename), binaryBytes);
    const binaryManifestPath = join(root, 'binary-manifest.json');
    writeFileSync(binaryManifestPath, JSON.stringify({ binaries: [{
      id: 'kb-create', os: 'linux', arch: 'amd64', version: '1.0.0',
      filename: binaryFilename, sha256: binarySha, sizeBytes: binaryBytes.length,
      url: `https://github.com/kb-labs-team/kb-labs/releases/download/v1/${binaryFilename}`,
    }] }));
    const releaseIndexPath = join(root, 'release-index.json');
    const sealedIndexBytes = Buffer.from(JSON.stringify({ platforms: [{
      id: 'platform', version: '1.0.0', binaries: [{ filename: binaryFilename, sha256: binarySha,
        url: `https://github.com/kb-labs-team/kb-labs/releases/download/v1/${binaryFilename}` }],
    }] }));
    writeFileSync(releaseIndexPath, sealedIndexBytes);
    const bundleDir = join(root, 'bundle');
    const provenance = createCandidateBundle({
      ...identity, channel: 'canary', gate: { policy: 'none' }, workflowRunId: '987654321',
      artifactsDir: sourceArtifacts, outputDir: bundleDir, releaseIndexPath,
      binaryManifestPath, binariesDir,
    });
    const verified = verifyCandidateBundle(bundleDir, { ...identity, expectedDigest: provenance.bundleDigest }, { targetKind: 'test' });
    const packagesDir = join(root, 'journey-packages');
    const candidateDir = join(root, 'journey-candidate');
    mkdirSync(packagesDir);
    writeFileSync(join(packagesDir, tarball), 'stale fixture package bytes');
    const excludedPackageDir = join(root, 'excluded/package');
    mkdirSync(excludedPackageDir, { recursive: true });
    writeFileSync(join(excludedPackageDir, 'package.json'), JSON.stringify({ name: '@kb-labs/source-only', version: '99.0.0' }));
    const sourceOnlyTarball = join(packagesDir, 'kb-labs-source-only-99.0.0.tgz');
    execFileSync('tar', ['-czf', sourceOnlyTarball, '-C', join(root, 'excluded'), 'package']);
    const updatePackageDir = join(root, 'update-fixture/package');
    mkdirSync(updatePackageDir, { recursive: true });
    writeFileSync(join(updatePackageDir, 'package.json'), JSON.stringify({ name: '@kb-labs/cli-bin', version: '1.0.1' }));
    const updateFilename = 'kb-labs-cli-bin-1.0.1.tgz';
    const updateTarball = join(packagesDir, updateFilename);
    execFileSync('tar', ['-czf', updateTarball, '-C', join(root, 'update-fixture'), 'package']);
    const updateBytes = readFileSync(updateTarball);
    const transitiveDir = join(root, 'transitive-fixture/package');
    mkdirSync(transitiveDir, { recursive: true });
    writeFileSync(join(transitiveDir, 'package.json'), JSON.stringify({ name: '@kb-labs/cli-runtime', version: '1.0.1' }));
    const transitiveFilename = 'kb-labs-cli-runtime-1.0.1.tgz';
    const transitiveTarball = join(packagesDir, transitiveFilename);
    execFileSync('tar', ['-czf', transitiveTarball, '-C', join(root, 'transitive-fixture'), 'package']);
    const transitiveBytes = readFileSync(transitiveTarball);
    mkdirSync(candidateDir);
    writeFileSync(join(candidateDir, 'release-index-update.json'), JSON.stringify({ artifacts: [{
      package: '@kb-labs/cli-bin', version: '1.0.1',
      tarball: 'http://verdaccio/@kb-labs/cli-bin/-/cli-bin-1.0.1.tgz',
      sha256: sha256(updateBytes),
    }], provenance: [{
      package: '@kb-labs/cli-runtime', version: '1.0.1',
      integrity: `sha512-${createHash('sha512').update(transitiveBytes).digest('base64')}`,
      distSha256: 'f'.repeat(64),
    }] }));

    stageSealedJourneyCandidate({ bundleDir, packagesDir, candidateDir, verified });

    expect(readFileSync(join(packagesDir, tarball))).toEqual(tarballBytes);
    expect(readdirSync(packagesDir).sort()).toEqual([tarball, updateFilename, transitiveFilename].sort());
    expect(readFileSync(join(candidateDir, binaryFilename))).toEqual(binaryBytes);
    expect(lstatSync(join(candidateDir, binaryFilename)).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(root, 'v1', binaryFilename))).toEqual(binaryBytes);
    expect(readFileSync(join(root, 'v1', 'checksums.txt'), 'utf8')).toBe(`${binarySha}  ${binaryFilename}\n`);
    expect(readFileSync(join(candidateDir, 'release-index.json'))).toEqual(sealedIndexBytes);
    const candidateChecksums = readFileSync(join(candidateDir, 'checksums.txt'), 'utf8');
    expect(candidateChecksums).toContain(`${sha256(sealedIndexBytes)}  release-index.json`);
    expect(candidateChecksums).toContain(`${binarySha}  ${binaryFilename}`);
    expect(readFileSync(join(candidateDir, 'candidate-bundle-digest.txt'), 'utf8')).toBe(`${provenance.bundleDigest}\n`);
    const stagedUpdateIndex = JSON.parse(readFileSync(join(candidateDir, 'release-index-update.json'), 'utf8')) as { artifacts: Array<{ tarball: string }> };
    expect(stagedUpdateIndex.artifacts[0]!.tarball)
      .toBe('http://verdaccio/@kb-labs/cli-bin/-/cli-bin-1.0.1.tgz');

    // The HTTP origin used by installer.sh exposes the staged exact bytes from
    // these paths, including the URL-derived mirror consumed by the CLI.
    const portServer = createNetServer();
    const originPort = await new Promise<number>(resolve => portServer.listen(0, '127.0.0.1', () => {
      const address = portServer.address();
      if (!address || typeof address === 'string') throw new Error('Could not allocate an origin test port');
      resolve(address.port);
    }));
    await new Promise<void>((resolve, reject) => portServer.close(error => error ? reject(error) : resolve()));
    const origin = spawn('python3', ['-m', 'http.server', String(originPort), '--bind', '127.0.0.1', '--directory', join(root)]);
    try {
      let ready = false;
      for (let attempt = 0; attempt < 30 && !ready; attempt++) {
        try { ready = (await fetch(`http://127.0.0.1:${originPort}/journey-candidate/release-index.json`)).ok; }
        catch { await new Promise(resolve => setTimeout(resolve, 50)); }
      }
      expect(ready).toBe(true);
      expect(Buffer.from(await (await fetch(`http://127.0.0.1:${originPort}/journey-candidate/release-index.json`)).arrayBuffer())).toEqual(sealedIndexBytes);
      expect(Buffer.from(await (await fetch(`http://127.0.0.1:${originPort}/journey-candidate/${binaryFilename}`)).arrayBuffer())).toEqual(binaryBytes);
      expect(Buffer.from(await (await fetch(`http://127.0.0.1:${originPort}/v1/${binaryFilename}`)).arrayBuffer())).toEqual(binaryBytes);
    } finally {
      origin.kill('SIGTERM');
    }

    // Exercise the actual package registry transport used by installer journeys.
    const registry = spawn(process.execPath, [
      join(repositoryRoot, 'e2e/journey/candidate-package-registry.mjs'), packagesDir, candidateDir, '0', 'http://127.0.0.1:9',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const registryUrl = await new Promise<string>((resolve, reject) => {
        let output = '';
        registry.stdout.setEncoding('utf8').on('data', chunk => {
          output += chunk;
          const line = output.split(/\r?\n/)[0];
          if (line) resolve(line);
        });
        registry.once('error', reject);
        registry.once('exit', code => reject(new Error(`candidate registry exited early (${code}): ${output}`)));
      });
      const metadataResponse = await fetch(`${registryUrl}/@kb-labs%2Ffixture`);
      expect(metadataResponse.ok).toBe(true);
      const metadata = await metadataResponse.json() as { versions: Record<string, { dist: { tarball: string } }> };
      const received = await fetch(metadata.versions['1.0.0']!.dist.tarball);
      expect(Buffer.from(await received.arrayBuffer())).toEqual(tarballBytes);
      const updateMetadataResponse = await fetch(`${registryUrl}/@kb-labs%2Fcli-bin`);
      const updateMetadata = await updateMetadataResponse.json() as { versions: Record<string, { dist: { tarball: string } }> };
      const servedUpdate = await fetch(updateMetadata.versions['1.0.1']!.dist.tarball);
      expect(Buffer.from(await servedUpdate.arrayBuffer())).toEqual(updateBytes);
      const transitiveMetadataResponse = await fetch(`${registryUrl}/@kb-labs%2Fcli-runtime`);
      const transitiveMetadata = await transitiveMetadataResponse.json() as { versions: Record<string, { dist: { tarball: string } }> };
      const servedTransitive = await fetch(transitiveMetadata.versions['1.0.1']!.dist.tarball);
      expect(Buffer.from(await servedTransitive.arrayBuffer())).toEqual(transitiveBytes);
    } finally {
      registry.kill('SIGTERM');
    }
  });

  // case: S-284.16
  it('rejects a tampered mode manifest before applying its permissions', () => {
    const { bundleDir, trust } = makeBundle();
    const provenancePath = join(bundleDir, 'provenance.json');
    const modesPath = join(bundleDir, 'bundle.modes');
    const modes = readFileSync(modesPath, 'utf8');
    const line = modes.split('\n').find(item => item.endsWith('  ./provenance.json'));
    if (!line) throw new Error('provenance mode entry missing');
    const tamperedModes = modes.replace(line, '777  ./provenance.json');
    writeFileSync(modesPath, tamperedModes);
    const checksumsPath = join(bundleDir, 'bundle.sha256');
    const checksums = readFileSync(checksumsPath, 'utf8');
    const modeChecksum = checksums.split('\n').find(item => item.endsWith('  ./bundle.modes'));
    if (!modeChecksum) throw new Error('mode checksum missing');
    writeFileSync(checksumsPath, checksums.replace(modeChecksum, `${createHash('sha256').update(tamperedModes).digest('hex')}  ./bundle.modes`));
    const before = lstatSync(provenancePath).mode & 0o777;
    expect(() => verifyCandidateBundle(bundleDir, trust, testPolicy)).toThrow(/digest/);
    expect(lstatSync(provenancePath).mode & 0o777).toBe(before);
  });
  // case: S-284.1
  it('creates a bundle whose provenance digest, exact file set, modes and package bytes verify', () => {
    const { bundleDir, trust } = makeBundle();
    const verified = verifyCandidateBundle(bundleDir, trust, testPolicy);

    expect(verified.provenance.bundleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(verified.artifacts).toHaveLength(1);
    expect(verified.artifactsDir).toBe(join(bundleDir, 'npm'));
    expect(verified.provenance.gate).toEqual({ policy: 'none' });
  });

  // case: S-284.16
  it('verifies after artifact download normalizes restrictive source modes', () => {
    root = mkdtempSync(join(tmpdir(), 'x241-candidate-'));
    const artifactsDir = join(root, 'source-artifacts');
    writeSource(artifactsDir, 'kb-labs-fixture-1.0.0.tgz', 'fixture tarball bytes');
    chmodSync(join(artifactsDir, 'manifest.json'), 0o600);
    chmodSync(join(artifactsDir, 'kb-labs-fixture-1.0.0.tgz'), 0o600);
    const binariesDir = join(root, 'binaries');
    mkdirSync(binariesDir);
    writeFileSync(join(binariesDir, 'executable'), 'binary');
    chmodSync(join(binariesDir, 'executable'), 0o700);
    const releaseIndexPath = join(root, 'release-index.json');
    writeFileSync(releaseIndexPath, JSON.stringify({ platforms: [{ id: 'platform', version: '1.0.0' }] }));
    chmodSync(releaseIndexPath, 0o600);
    const bundleDir = join(root, 'bundle');
    const provenance = createCandidateBundle({
      ...identity,
      channel: 'canary',
      gate: { policy: 'none', result: 'skipped' },
      workflowRunId: '1234',
      artifactsDir,
      releaseIndexPath,
      binariesDir,
      outputDir: bundleDir,
    });

    const downloadedDir = join(root, 'downloaded');
    cpSync(bundleDir, downloadedDir, { recursive: true });
    const normalizeDownloadedModes = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) normalizeDownloadedModes(path);
        else chmodSync(path, (lstatSync(path).mode & 0o111) !== 0 ? 0o755 : 0o644);
      }
    };
    normalizeDownloadedModes(downloadedDir);

    expect(() => verifyCandidateBundle(downloadedDir, { ...identity, expectedDigest: provenance.bundleDigest }, testPolicy)).not.toThrow();
  });

  // case: S-284.5
  it('allows a canary bundle at a declared test target', () => {
    const { bundleDir, trust } = makeBundle();

    expect(() => verifyCandidateBundle(bundleDir, trust, {
      targetKind: 'test',
    })).not.toThrow();
  });

  // case: S-284.5
  it('refuses a canary bundle at a public target', () => {
    const { bundleDir, trust } = makeBundle();

    expect(() => verifyCandidateBundle(bundleDir, trust, {
      targetKind: 'public',
    })).toThrow(/Public delivery requires a channel with a passed release-case gate/);
  });

  // case: S-284.23
  it('seals stable payload intent without claiming that its gate has passed', () => {
    const { provenance } = makeBundle(false, 'kb-labs-fixture-1.0.0.tgz', 'fixture tarball bytes', 'stable', {
      policy: 'release-cases', result: 'failed', runId: 'journey-run-17',
    });
    expect(provenance.gate).toEqual({ policy: 'release-cases' });
    expect(provenance.schema).toBe('kb.release-provenance/4');
  });

  // case: S-284.23
  it('requires a separate exact-digest receipt to authorize stable delivery', () => {
    const { bundleDir, trust, provenance } = makeBundle(false, 'kb-labs-fixture-1.0.0.tgz', 'fixture tarball bytes', 'stable', {
      policy: 'release-cases', result: 'passed', runId: 'journey-run-17',
    });
    expect(() => verifyCandidateBundle(bundleDir, trust, { targetKind: 'public' }))
      .toThrow(/requires trusted candidate channel and workflow run values/);
    const receipt = {
      schema: 'kb.release-gate-attestation/1',
      candidateId: provenance.candidateId,
      commit: provenance.commit,
      flow: provenance.flow,
      version: provenance.version,
      channel: provenance.channel,
      bundleDigest: provenance.bundleDigest,
      workflowRunId: provenance.workflowRunId,
      policy: 'release-cases',
      result: 'passed',
    };
    expect(() => verifyCandidateBundle(bundleDir, {
      ...trust, channel: 'stable', workflowRunId: '1234',
    }, {
      targetKind: 'public',
      gateAttestation: receipt,
      trustedWorkflowRunId: '1234',
    })).not.toThrow();
  });

  // case: S-284.23
  it('does not treat the legacy v3 embedded passed result as digest-bound gate proof', () => {
    const { bundleDir, trust } = makeBundle(false, 'kb-labs-fixture-1.0.0.tgz', 'fixture tarball bytes', 'stable', {
      policy: 'release-cases', result: 'passed', runId: 'old-journey-run',
    });
    const expectedDigest = resealLegacyProvenance(bundleDir);
    expect(() => verifyCandidateBundle(bundleDir, {
      ...trust, expectedDigest, channel: 'stable', workflowRunId: '1234',
    }, { targetKind: 'public', trustedWorkflowRunId: '1234' })).toThrow(/requires matching passed release-case gate evidence/);
  });

  // case: S-284.5
  it('rejects provenance without the required gate field', () => {
    const { bundleDir, trust } = makeBundle();
    const provenancePath = join(bundleDir, 'provenance.json');
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as Record<string, unknown>;
    delete provenance.gate;
    writeFileSync(provenancePath, JSON.stringify(provenance, null, 2) + '\n');

    expect(() => verifyCandidateBundle(bundleDir, trust, {
      targetKind: 'test',
    })).toThrow(/gate/);
  });

  // case: S-284.5
  it('rejects edited provenance against the hosted digest in a scratch bundle', () => {
    const { bundleDir, trust } = makeBundle();
    const provenancePath = join(bundleDir, 'provenance.json');
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as Record<string, unknown>;
    provenance.channel = 'stable';
    writeFileSync(provenancePath, JSON.stringify(provenance, null, 2) + '\n');

    expect(() => verifyCandidateBundle(bundleDir, trust, {
      targetKind: 'test',
    })).toThrow(/digest/);
  });

  // case: S-284.1
  it('rejects a tarball changed after the candidate was sealed', () => {
    const { bundleDir, tarballPath, trust } = makeBundle();
    writeFileSync(tarballPath, 'tampered bytes');

    expect(() => verifyCandidateBundle(bundleDir, trust, testPolicy)).toThrow(/digest/);
  });

  // case: S-284.1
  it('rejects a changed tarball even when every colocated seal is regenerated', () => {
    const original = makeBundle();
    const sourceDir = join(root, 'attacker-artifacts');
    writeSource(sourceDir, 'kb-labs-fixture-1.0.0.tgz', 'attacker tarball bytes');
    const releaseIndexPath = join(root, 'attacker-release-index.json');
    writeFileSync(releaseIndexPath, JSON.stringify({ platforms: [{ id: 'platform', version: '1.0.0' }] }));
    const rewrittenBundle = join(root, 'rewritten-bundle');
    const rewrittenProvenance = createCandidateBundle({
      ...identity,
      channel: 'canary',
      gate: { policy: 'none', result: 'skipped' },
      workflowRunId: '1234',
      artifactsDir: sourceDir,
      releaseIndexPath,
      outputDir: rewrittenBundle,
    });

    expect(rewrittenProvenance.bundleDigest).not.toBe(original.trust.expectedDigest);
    expect(() => verifyCandidateBundle(rewrittenBundle, original.trust, testPolicy)).toThrow(/trusted candidate digest/);
  });

  // case: S-284.1
  it('binds payload file modes into the trusted digest', () => {
    const original = makeBundle();
    const sourceDir = join(root, 'changed-mode-artifacts');
    writeSource(sourceDir, 'kb-labs-fixture-1.0.0.tgz', 'fixture tarball bytes');
    chmodSync(join(sourceDir, 'kb-labs-fixture-1.0.0.tgz'), 0o755);
    const releaseIndexPath = join(root, 'changed-mode-index.json');
    writeFileSync(releaseIndexPath, JSON.stringify({ platforms: [{ id: 'platform', version: '1.0.0' }] }));
    const changedModeBundle = join(root, 'changed-mode-bundle');
    createCandidateBundle({
      ...identity,
      channel: 'canary',
      gate: { policy: 'none', result: 'skipped' },
      workflowRunId: '1234',
      artifactsDir: sourceDir,
      releaseIndexPath,
      outputDir: changedModeBundle,
    });

    expect(() => verifyCandidateBundle(changedModeBundle, original.trust, testPolicy)).toThrow(/trusted candidate digest/);
  });

  for (const [_field, changed] of [
    ['candidateId', { candidateId: 'other-candidate' }],
    ['commit', { commit: '2234567890123456789012345678901234567890' }],
    ['flow', { flow: 'sdk' }],
    ['version', { version: '1.0.1' }],
  ] as const) {
  // case: S-284.1
  it('rejects a candidate that differs from the trusted identity', () => {
    const { bundleDir, trust } = makeBundle();

    expect(() => verifyCandidateBundle(bundleDir, { ...trust, ...changed }, testPolicy)).toThrow(/trusted candidate identity/);
  });
  }

  // case: S-284.1
  it('rejects an unlisted file instead of publishing an expanded bundle', () => {
    const { bundleDir, trust } = makeBundle();
    writeFileSync(join(bundleDir, 'unlisted.txt'), 'unexpected');

    expect(() => verifyCandidateBundle(bundleDir, trust, testPolicy)).toThrow(/digest/);
  });

  // case: S-284.1
  it('rejects metacharacters in npm tarball filenames', () => {
    expect(() => makeBundle(false, 'kb-labs-fixture-1.0.0.tgz;touch-pwned')).toThrow(/invalid npm tarball filename/);
  });

  for (const filename of ['bundle.sha256', 'bundle.modes']) {
  // case: S-284.1
  it('requires a canonical mode', () => {
    const { bundleDir, trust } = makeBundle();
    chmodSync(join(bundleDir, filename), 0o600);

    expect(() => verifyCandidateBundle(bundleDir, trust, testPolicy)).toThrow(/canonical mode/);
  });
  }

  // case: S-284.1
  it('rejects an npm file set that differs from the artifact manifest', () => {
    root = mkdtempSync(join(tmpdir(), 'x241-candidate-'));
    const artifactsDir = join(root, 'source-artifacts');
    mkdirSync(artifactsDir);
    const tarball = 'kb-labs-fixture-1.0.0.tgz';
    const tarballBytes = 'fixture tarball bytes';
    writeFileSync(join(artifactsDir, tarball), tarballBytes);
    writeFileSync(join(artifactsDir, 'manifest.json'), JSON.stringify([{
      name: '@kb-labs/fixture',
      version: '1.0.0',
      tarball,
      sha256: createHash('sha256').update(tarballBytes).digest('hex'),
    }]));
    writeFileSync(join(artifactsDir, 'unlisted.tgz'), 'unexpected');
    const releaseIndexPath = join(root, 'release-index.json');
    writeFileSync(releaseIndexPath, JSON.stringify({ platforms: [{ id: 'platform', version: '1.0.0' }] }));

    expect(() => createCandidateBundle({
      ...identity,
      channel: 'canary',
      gate: { policy: 'none', result: 'skipped' },
      workflowRunId: '1234',
      artifactsDir,
      releaseIndexPath,
      outputDir: join(root, 'bundle'),
    })).toThrow(/npm file set differs/);
  });
});
