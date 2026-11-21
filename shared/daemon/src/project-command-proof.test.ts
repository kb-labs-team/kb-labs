import { describe, expect, it } from 'vitest';
import { createProjectCommandExecutionProof, matchesProjectCommandExecutionProof } from './project-command-proof.js';

describe('project command guard proofs', () => {
  // case: S-160.1
  it('rejects a proof at the exact expiry boundary', () => {
    const context = { projectId: 'project-proof-expiry', method: 'POST', path: '/api/v1/commands/execute' };
    const proof = createProjectCommandExecutionProof('test-runtime-secret', context);
    const createdAt = Number(proof.split('.')[0]);

    expect(matchesProjectCommandExecutionProof('test-runtime-secret', proof, context, createdAt + 30_000)).toBe(false);
  });
});
