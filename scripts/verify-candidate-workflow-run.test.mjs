import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyCandidateWorkflowRun } from './candidate-workflow-run.mjs';

// case: S-284.23
test('candidate gate receipt source must be the successful trusted release workflow run', () => {
  const trusted = {
    path: '.github/workflows/release-build-candidate.yml@master',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'master',
    head_repository: { full_name: 'kb-labs-team/kb-labs' },
  };
  assert.doesNotThrow(() => verifyCandidateWorkflowRun(trusted, { repository: 'kb-labs-team/kb-labs' }));
  assert.doesNotThrow(() => verifyCandidateWorkflowRun({ ...trusted, path: '.github/workflows/release-build-candidate.yml' }, { repository: 'kb-labs-team/kb-labs' }));

  for (const changed of [
    { path: '.github/workflows/other.yml@master' },
    { path: '.github/workflows/release-build-candidate.yml@feature/untrusted' },
    { path: '.github/workflows/release-build-candidate.yml@refs/heads/feature/untrusted' },
    { event: 'push' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { head_branch: 'feature/untrusted' },
    { head_repository: { full_name: 'attacker/repo' } },
  ]) {
    assert.throws(() => verifyCandidateWorkflowRun({ ...trusted, ...changed }, { repository: 'kb-labs-team/kb-labs' }));
  }
});
