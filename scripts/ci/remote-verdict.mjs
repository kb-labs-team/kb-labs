export function parseVerdict(value, expectedSha) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Remote verdict must be a JSON object');
  if (value.sha !== expectedSha) throw new Error(`Remote verdict SHA mismatch: expected ${expectedSha}, received ${String(value.sha)}`);
  if (!['pass', 'partial', 'fail', 'timeout', 'outage'].includes(value.status)) throw new Error(`Invalid remote verdict status: ${String(value.status)}`);
  if (!Array.isArray(value.jobs)) throw new Error('Remote verdict jobs must be an array');
  if (value.profile === 'candidate' && value.internalToolResults === undefined) {
    throw new Error('Remote verdict internal-tool results are required for candidate verification');
  }
  if (value.profile === 'platform') {
    const scope = value.scope;
    if (value.status === 'pass') throw new Error('Platform remote verdict cannot be labeled as a full pass');
    if (scope) {
      const expectedChecks = ['internal-tool build', 'internal-tool test', 'internal-tool package checks'];
      const selected = value.selection?.packages;
      if (scope.name !== 'platform' || scope.status !== 'partial' || !Array.isArray(scope.excludedPackages) || scope.excludedPackages.some((name) => typeof name !== 'string' || !name) || new Set(scope.excludedPackages).size !== scope.excludedPackages.length || JSON.stringify(scope.excludedChecks) !== JSON.stringify(expectedChecks) || typeof scope.warning !== 'string' || !scope.warning || !Array.isArray(selected) || selected.some((name) => typeof name !== 'string' || !name) || new Set(selected).size !== selected.length || scope.excludedPackages.some((name) => selected.includes(name))) {
        throw new Error('Platform remote verdict contains an invalid partial-scope exclusion manifest');
      }
    } else if (value.status !== 'fail' || !value.diagnostics?.some((item) => /^platform /i.test(item)) || !value.jobs.some((job) => job.name === 'platform-scope-manifest' && job.status === 'fail')) {
      throw new Error('Platform remote verdict must retain its partial-scope exclusion manifest or a named manifest failure');
    }
    if (value.status === 'partial') {
      if (!scope || !value.jobs.some((job) => job.name === 'ci-script-suite' && job.status === 'pass') || !value.internalToolResults || value.internalToolResults.status !== 'pass' || !Array.isArray(value.internalToolResults.jobs) || value.internalToolResults.jobs.length > 0) {
        throw new Error('A partial platform verdict requires its exclusion manifest, selected suite evidence, and no internal-tool jobs');
      }
    }
  } else if (value.status === 'partial') {
    throw new Error('Only the platform verification profile may return a partial verdict');
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
  if (value.status === 'partial' && value.jobs.some((job) => job.status !== 'pass')) throw new Error('A partial verdict requires every selected job to pass');
  return value;
}

export function verificationWorkflowPath(profile = 'stream') {
  return profile === 'platform' ? '.github/workflows/platform-verify.yml' : '.github/workflows/remote-verify.yml';
}

export function verificationRunTitle(profile, branch) {
  return profile === 'platform'
    ? `Platform verification (partial) for ${branch}`
    : `Remote agent verification (${profile}) for ${branch}`;
}

export function terminalVerdict(sha, status, message) {
  if (!['timeout', 'outage'].includes(status)) throw new Error(`Invalid terminal verdict status: ${status}`);
  return { schemaVersion: 1, sha, status, jobs: [], diagnostics: [message] };
}

export class VerificationRemoteError extends Error {
  constructor(remoteName, reason, options = {}) {
    super(`[VERIFICATION_REMOTE_INVALID] Verification remote "${remoteName}" ${reason}. Configure it as a GitHub remote or select an existing remote with --remote <name>.`, options);
    this.name = 'VerificationRemoteError';
    this.code = 'VERIFICATION_REMOTE_INVALID';
    this.remoteName = remoteName;
  }
}

export function repositoryFromRemote(url, remoteName = 'origin') {
  const match = typeof url === 'string'
    ? url.match(/^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)
    : undefined;
  if (!match) throw new VerificationRemoteError(remoteName, 'must point to a GitHub repository URL');
  return match[1];
}

export function selectVerificationRun(runs, { branch, sha, workflowPath, event = 'push', profile = 'stream' }) {
  const title = verificationRunTitle(profile, branch);
  return runs.find((item) => item.event === event && item.head_branch === branch && item.head_sha === sha && item.path === (workflowPath ?? verificationWorkflowPath(profile)) && item.display_title === title);
}
