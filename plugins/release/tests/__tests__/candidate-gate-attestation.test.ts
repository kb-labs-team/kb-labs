import { describe, expect, it } from 'vitest';
import { verifyCandidateGateAttestation, type CandidateGateAttestation } from '../../src/shared/candidate-gate-attestation.js';

describe('candidate gate receipt', () => {
  const expected = {
    candidateId: 'candidate-1',
    commit: '1234567890123456789012345678901234567890',
    flow: 'platform',
    version: '2.0.0',
    channel: 'stable' as const,
    bundleDigest: 'a'.repeat(64),
    workflowRunId: '987654321',
    policy: 'release-cases' as const,
    result: 'passed' as const,
  };

  // case: S-284.23
  it('accepts receipt fields bound to the sealed payload and trusted workflow run', () => {
    expect(() => verifyCandidateGateAttestation({
      schema: 'kb.release-gate-attestation/1',
      ...expected,
    }, expected, expected.workflowRunId)).not.toThrow();
  });

  // case: S-284.23
  it('rejects receipts with a mismatched payload digest, candidate identity, run, channel, or result', () => {
    const changes = [
      ['payload digest', { bundleDigest: 'b'.repeat(64) }],
      ['candidate identity', { candidateId: 'other-candidate' }],
      ['source workflow run', { workflowRunId: 'different-run' }],
      ['release channel', { channel: 'canary' }],
      ['gate result', { result: 'failed' }],
    ] as const;
    for (const [_label, overrides] of changes) {
      const receipt: CandidateGateAttestation = {
        schema: 'kb.release-gate-attestation/1',
        ...expected,
        ...overrides,
      } as CandidateGateAttestation;
      expect(() => verifyCandidateGateAttestation(receipt, expected, expected.workflowRunId)).toThrow();
    }
  });

  // case: S-284.23
  it('rejects a receipt without an independently trusted workflow run', () => {
    expect(() => verifyCandidateGateAttestation({
      schema: 'kb.release-gate-attestation/1',
      ...expected,
    }, expected, '')).toThrow(/trusted candidate workflow run/);
  });
});
