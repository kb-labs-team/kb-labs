import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCandidateBundle, verifyCandidateBundle } from '../../src/shared/candidate-bundle.js';

let root: string;

const identity = {
  candidateId: 'test-candidate',
  commit: '1234567890123456789012345678901234567890',
  flow: 'platform',
  version: '1.0.0',
};

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

function makeBundle(includeUnlistedNpmFile = false, tarball = 'kb-labs-fixture-1.0.0.tgz', tarballBytes = 'fixture tarball bytes') {
  root = mkdtempSync(join(tmpdir(), 'x241-candidate-'));
  const artifactsDir = join(root, 'source-artifacts');
  writeSource(artifactsDir, tarball, tarballBytes, includeUnlistedNpmFile);
  const releaseIndexPath = join(root, 'release-index.json');
  writeFileSync(releaseIndexPath, JSON.stringify({ platforms: [{ id: 'platform', version: '1.0.0' }] }));
  const bundleDir = join(root, 'bundle');
  const provenance = createCandidateBundle({
    ...identity,
    channel: 'canary',
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
  // case: S-284.1
  it('creates a bundle whose provenance digest, exact file set, modes and package bytes verify', () => {
    const { bundleDir, trust } = makeBundle();
    const verified = verifyCandidateBundle(bundleDir, trust);

    expect(verified.provenance.bundleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(verified.artifacts).toHaveLength(1);
    expect(verified.artifactsDir).toBe(join(bundleDir, 'npm'));
  });

  // case: S-284.1
  it('rejects a tarball changed after the candidate was sealed', () => {
    const { bundleDir, tarballPath, trust } = makeBundle();
    writeFileSync(tarballPath, 'tampered bytes');

    expect(() => verifyCandidateBundle(bundleDir, trust)).toThrow(/digest differs/);
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
      workflowRunId: '1234',
      artifactsDir: sourceDir,
      releaseIndexPath,
      outputDir: rewrittenBundle,
    });

    expect(rewrittenProvenance.bundleDigest).not.toBe(original.trust.expectedDigest);
    expect(() => verifyCandidateBundle(rewrittenBundle, original.trust)).toThrow(/trusted candidate digest/);
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
      workflowRunId: '1234',
      artifactsDir: sourceDir,
      releaseIndexPath,
      outputDir: changedModeBundle,
    });

    expect(() => verifyCandidateBundle(changedModeBundle, original.trust)).toThrow(/trusted candidate digest/);
  });

  // case: S-284.1
  it.each([
    ['candidateId', { candidateId: 'other-candidate' }],
    ['commit', { commit: '2234567890123456789012345678901234567890' }],
    ['flow', { flow: 'sdk' }],
    ['version', { version: '1.0.1' }],
  ])('rejects a candidate that differs from the trusted %s', (_field, changed) => {
    const { bundleDir, trust } = makeBundle();

    expect(() => verifyCandidateBundle(bundleDir, { ...trust, ...changed })).toThrow(/trusted candidate identity/);
  });

  // case: S-284.1
  it('rejects an unlisted file instead of publishing an expanded bundle', () => {
    const { bundleDir, trust } = makeBundle();
    writeFileSync(join(bundleDir, 'unlisted.txt'), 'unexpected');

    expect(() => verifyCandidateBundle(bundleDir, trust)).toThrow(/file set differs/);
  });

  // case: S-284.1
  it('rejects metacharacters in npm tarball filenames', () => {
    expect(() => makeBundle(false, 'kb-labs-fixture-1.0.0.tgz;touch-pwned')).toThrow(/invalid npm tarball filename/);
  });

  // case: S-284.1
  it.each(['bundle.sha256', 'bundle.modes'])('requires a canonical mode for %s', filename => {
    const { bundleDir, trust } = makeBundle();
    chmodSync(join(bundleDir, filename), 0o600);

    expect(() => verifyCandidateBundle(bundleDir, trust)).toThrow(/canonical mode/);
  });

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
      workflowRunId: '1234',
      artifactsDir,
      releaseIndexPath,
      outputDir: join(root, 'bundle'),
    })).toThrow(/npm file set differs/);
  });
});
