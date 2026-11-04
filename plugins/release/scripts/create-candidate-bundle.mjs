import { appendFileSync } from 'node:fs';
import { createCandidateBundle } from '../dist/shared/candidate-bundle.js';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const provenance = createCandidateBundle({
  candidateId: required('CANDIDATE_ID'),
  commit: required('COMMIT_SHA'),
  flow: required('FLOW'),
  version: required('VERSION'),
  channel: required('CHANNEL'),
  gate: {
    policy: required('GATE_POLICY'),
    result: required('GATE_RESULT'),
    ...(process.env.GATE_RUN_ID ? { runId: process.env.GATE_RUN_ID } : {}),
  },
  workflowRunId: required('RUN_ID'),
  artifactsDir: required('ARTIFACTS_DIR'),
  outputDir: required('BUNDLE_DIR'),
  releaseIndexPath: process.env.RELEASE_INDEX_PATH,
  binaryManifestPath: process.env.BINARY_MANIFEST_PATH,
  binariesDir: process.env.BINARIES_DIR,
});

const trustedIdentity = {
  candidateId: provenance.candidateId,
  commit: provenance.commit,
  flow: provenance.flow,
  version: provenance.version,
  bundleDigest: provenance.bundleDigest,
};
const summary = [
  '## Immutable candidate trust values',
  '',
  'Use these values from this hosted run when delivering the downloaded candidate bundle:',
  '',
  ...Object.entries(trustedIdentity).map(([name, value]) => `- **${name}:** \`${value}\``),
  '',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
} else {
  process.stdout.write(`${summary}\n`);
}
