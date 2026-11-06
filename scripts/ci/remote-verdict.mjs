export function parseVerdict(value, expectedSha) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Remote verdict must be a JSON object');
  if (value.sha !== expectedSha) throw new Error(`Remote verdict SHA mismatch: expected ${expectedSha}, received ${String(value.sha)}`);
  if (!['pass', 'fail', 'timeout', 'outage'].includes(value.status)) throw new Error(`Invalid remote verdict status: ${String(value.status)}`);
  if (!Array.isArray(value.jobs)) throw new Error('Remote verdict jobs must be an array');
  if (value.profile === 'candidate' && value.internalToolResults === undefined) {
    throw new Error('Remote verdict internal-tool results are required for candidate verification');
  }
  if (value.internalToolResults !== undefined) {
    if (!value.internalToolResults || !['pass', 'fail'].includes(value.internalToolResults.status) || !Array.isArray(value.internalToolResults.jobs)) {
      throw new Error('Remote verdict internal-tool results are invalid');
    }
    for (const job of value.internalToolResults.jobs) {
      if (!job || typeof job.name !== 'string' || !['pass', 'fail', 'timeout', 'outage', 'skipped'].includes(job.status)) {
        throw new Error('Remote verdict contains an invalid internal-tool result');
      }
      if (!['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral', 'stale', 'startup_failure', 'unknown'].includes(job.jobConclusion)) {
        throw new Error(`Remote verdict internal-tool result ${job.name} is missing a valid job conclusion`);
      }
      if (!Array.isArray(job.failures) || typeof job.logTail !== 'string') throw new Error(`Remote verdict internal-tool result ${job.name} is missing diagnostics`);
    }
    if (value.internalToolResults.status === 'pass' && value.internalToolResults.jobs.some((job) => job.status !== 'pass')) {
      throw new Error('Passing internal-tool results cannot contain a non-passing job');
    }
  }
  for (const job of value.jobs) {
    if (!job || typeof job.name !== 'string' || !['pass', 'fail', 'timeout', 'outage', 'skipped'].includes(job.status)) {
      throw new Error('Remote verdict contains an invalid job result');
    }
    if (!Array.isArray(job.failures) || typeof job.logTail !== 'string') throw new Error(`Remote verdict job ${job.name} is missing diagnostics`);
  }
  if (value.status === 'pass' && value.jobs.some((job) => job.status !== 'pass')) throw new Error('A passing verdict cannot contain a non-passing job');
  return value;
}

export function terminalVerdict(sha, status, message) {
  if (!['timeout', 'outage'].includes(status)) throw new Error(`Invalid terminal verdict status: ${status}`);
  return { schemaVersion: 1, sha, status, jobs: [], diagnostics: [message] };
}

export function repositoryFromRemote(url) {
  const match = url.match(/(?:^[^@]+@[^:]+:|^https?:\/\/[^/]+\/)([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!match) throw new Error(`backup remote is not a GitHub repository: ${url}`);
  return match[1];
}

export function selectVerificationRun(runs, { branch, sha, workflowPath, event = 'push', profile = 'stream' }) {
  const title = `Remote agent verification (${profile}) for ${branch}`;
  return runs.find((item) => item.event === event && item.head_branch === branch && item.head_sha === sha && item.path === workflowPath && item.display_title === title);
}
