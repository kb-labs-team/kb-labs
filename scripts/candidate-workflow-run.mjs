export function verifyCandidateWorkflowRun(run, { repository, expectedBranch = 'master' }) {
  const [workflowPath, workflowRef] = typeof run?.path === 'string' ? run.path.split('@', 2) : [];
  // The Actions REST endpoint returns a bare workflow path for dispatch runs;
  // when a ref suffix is present, validate it too.
  const trustedRef = workflowRef === undefined || workflowRef === expectedBranch || workflowRef === `refs/heads/${expectedBranch}`;
  if (!run || typeof run !== 'object'
    || workflowPath !== '.github/workflows/release-build-candidate.yml'
    || !trustedRef
    || run.event !== 'workflow_dispatch'
    || run.status !== 'completed'
    || run.conclusion !== 'success'
    || run.head_branch !== expectedBranch
    || run.head_repository?.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('Candidate gate receipt did not come from a successful trusted release-build-candidate workflow run');
  }
}
