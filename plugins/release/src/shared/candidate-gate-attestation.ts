import type { ReleaseChannel } from '../core/types.js';

export interface CandidateGateAttestationSubject {
  candidateId: string;
  commit: string;
  flow: string;
  version: string;
  channel: ReleaseChannel;
  bundleDigest: string;
  workflowRunId: string;
  policy: 'release-cases';
  result: 'passed';
}

export interface CandidateGateAttestation extends CandidateGateAttestationSubject {
  schema: 'kb.release-gate-attestation/1';
}

export class CandidateGateAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandidateGateAttestationError';
  }
}

export function verifyCandidateGateAttestation(
  value: unknown,
  expected: CandidateGateAttestationSubject,
  trustedWorkflowRunId: string,
): CandidateGateAttestation {
  if (!trustedWorkflowRunId) {
    throw new CandidateGateAttestationError('A trusted candidate workflow run is required to verify gate evidence');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CandidateGateAttestationError('Candidate gate receipt must be a JSON object');
  }
  const receipt = value as Partial<CandidateGateAttestation>;
  if (receipt.schema !== 'kb.release-gate-attestation/1'
    || receipt.policy !== 'release-cases' || receipt.result !== 'passed'
    || !receipt.candidateId || !receipt.commit || !receipt.flow || !receipt.version
    || !receipt.workflowRunId || !receipt.bundleDigest
    || !['canary', 'stable'].includes(receipt.channel ?? '')) {
    throw new CandidateGateAttestationError('Candidate gate receipt is incomplete or unsupported');
  }
  if (!/^[a-f0-9]{64}$/.test(receipt.bundleDigest)) {
    throw new CandidateGateAttestationError('Candidate gate receipt has an invalid payload digest');
  }
  if (receipt.workflowRunId !== trustedWorkflowRunId) {
    throw new CandidateGateAttestationError('Candidate gate receipt does not match the trusted candidate workflow run');
  }
  for (const key of ['candidateId', 'commit', 'flow', 'version', 'channel', 'bundleDigest', 'workflowRunId', 'policy', 'result'] as const) {
    if (receipt[key] !== expected[key]) {
      throw new CandidateGateAttestationError(`Candidate gate receipt does not match the verified candidate ${key}`);
    }
  }
  return receipt as CandidateGateAttestation;
}
