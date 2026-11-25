import { resolve } from 'node:path';
import { verifyCandidateBundleIntegrity } from '../dist/shared/candidate-bundle.js';
import { stageSealedJourneyCandidate } from '../dist/shared/stage-sealed-journey-candidate.js';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const bundleDir = resolve(required('CANDIDATE_BUNDLE_DIR'));
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

stageSealedJourneyCandidate({
  bundleDir,
  packagesDir: required('JOURNEY_PACKAGES_DIR'),
  candidateDir: required('JOURNEY_CANDIDATE_DIR'),
  verified,
});
console.log(`Staged sealed candidate ${provenance.candidateId} at payload digest ${provenance.bundleDigest}`);
