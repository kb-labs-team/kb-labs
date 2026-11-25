import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyCandidateBundleIntegrity } from '../dist/shared/candidate-bundle.js';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const bundleDir = resolve(required('CANDIDATE_BUNDLE_DIR'));
const packagesDir = resolve(required('JOURNEY_PACKAGES_DIR'));
const candidateDir = resolve(required('JOURNEY_CANDIDATE_DIR'));
const trust = {
  expectedDigest: required('CANDIDATE_BUNDLE_DIGEST'),
  candidateId: required('CANDIDATE_ID'),
  commit: required('COMMIT_SHA'),
  flow: required('FLOW'),
  version: required('VERSION'),
  channel: required('CHANNEL'),
  workflowRunId: required('CANDIDATE_RUN_ID'),
};
const verified = verifyCandidateBundleIntegrity(bundleDir, trust);
const provenance = verified.provenance;
if (provenance.channel !== trust.channel || provenance.workflowRunId !== trust.workflowRunId) {
  throw new Error('Sealed candidate channel or workflow run differs from the trusted journey inputs');
}

mkdirSync(packagesDir, { recursive: true });
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.tgz')) rmSync(join(packagesDir, entry.name));
}
for (const artifact of verified.artifacts) {
  copyFileSync(join(verified.artifactsDir, artifact.tarball), join(packagesDir, artifact.tarball));
}

rmSync(candidateDir, { recursive: true, force: true });
mkdirSync(candidateDir, { recursive: true });
copyFileSync(join(bundleDir, 'release-index.json'), join(candidateDir, 'release-index.json'));
copyFileSync(join(bundleDir, 'binary-manifest.json'), join(candidateDir, 'binary-manifest.json'));
const binaryManifest = JSON.parse(readFileSync(join(bundleDir, 'binary-manifest.json'), 'utf8'));
for (const binary of binaryManifest.binaries ?? []) {
  if (typeof binary.filename !== 'string' || !binary.filename || binary.filename.includes('/') || binary.filename.includes('\\')) {
    throw new Error('Sealed candidate binary manifest contains an invalid filename');
  }
  const source = join(bundleDir, 'binaries', binary.filename);
  const target = join(candidateDir, binary.filename);
  copyFileSync(source, target);
  binary.url = `http://origin:8080/journey-candidate/${binary.filename}`;
}
const releaseIndex = JSON.parse(readFileSync(join(candidateDir, 'release-index.json'), 'utf8'));
const binaryByFilename = new Map((binaryManifest.binaries ?? []).map(binary => [binary.filename, binary]));
const rewriteUrls = value => {
  if (Array.isArray(value)) return value.map(rewriteUrls);
  if (!value || typeof value !== 'object') return value;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'url' && typeof entry === 'string') {
      const filename = entry.split('/').pop();
      if (filename && binaryByFilename.has(filename)) value[key] = `http://origin:8080/journey-candidate/${filename}`;
    } else {
      value[key] = rewriteUrls(entry);
    }
  }
  return value;
};
writeFileSync(join(candidateDir, 'binary-manifest.json'), `${JSON.stringify(binaryManifest, null, 2)}\n`);
writeFileSync(join(candidateDir, 'release-index.json'), `${JSON.stringify(rewriteUrls(releaseIndex), null, 2)}\n`);
console.log(`Staged sealed candidate ${provenance.candidateId} at payload digest ${provenance.bundleDigest}`);
