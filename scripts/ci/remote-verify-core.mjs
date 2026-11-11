import { parseVerdict, repositoryFromRemote, selectVerificationRun, VerificationRemoteError } from './remote-verdict.mjs';
import { candidateIntegrationBase } from './remote-selection-base.mjs';

const WORKFLOW_PATH = '.github/workflows/remote-verify.yml';
const MAX_RETRY_DELAY_MS = 60_000;

export class RemoteOperationError extends Error {
  constructor(message, { retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'RemoteOperationError';
    this.retryable = retryable;
  }
}

export class RemoteAuthError extends RemoteOperationError {
  constructor(message, options = {}) {
    super(message, { ...options, retryable: false });
    this.name = 'RemoteAuthError';
  }
}

export class RemoteNotFoundError extends RemoteOperationError {
  constructor(message, options = {}) {
    super(message, { ...options, retryable: false });
    this.name = 'RemoteNotFoundError';
  }
}

export class RemoteTimeoutError extends Error {
  constructor(message = 'Remote verification deadline expired') {
    super(message);
    this.name = 'RemoteTimeoutError';
  }
}

export class RemoteOutageError extends Error {
  constructor(message = 'GitHub or git remained unavailable beyond the outage budget') {
    super(message);
    this.name = 'RemoteOutageError';
  }
}

export async function retryOperation(operation, { deadlineAt, outageBudgetMs, now, sleep, callRemote, cadenceMs }) {
  let outageStartedAt;
  let attempt = 0;
  while (true) {
    if (now() >= deadlineAt) throw new RemoteTimeoutError();
    if (outageStartedAt !== undefined && now() - outageStartedAt >= outageBudgetMs) throw new RemoteOutageError();
    try {
      return await callRemote(operation, deadlineAt);
    } catch (error) {
      if (error?.retryable !== true) throw error;
      const failedAt = now();
      outageStartedAt ??= failedAt;
      if (failedAt >= deadlineAt) throw new RemoteTimeoutError();
      if (failedAt - outageStartedAt >= outageBudgetMs) throw new RemoteOutageError();
      const outageLeft = outageBudgetMs - (failedAt - outageStartedAt);
      const deadlineLeft = deadlineAt - failedAt;
      const delay = Math.min(cadenceMs * (2 ** attempt), MAX_RETRY_DELAY_MS, outageLeft, deadlineLeft);
      await sleep(delay);
      attempt += 1;
    }
  }
}

function createRemoteCaller(clock, cadenceMs) {
  let lastCallAt;
  return async (operation, deadlineAt) => {
    if (lastCallAt !== undefined) {
      const waitMs = Math.max(0, cadenceMs - (clock.now() - lastCallAt));
      if (waitMs > 0) {
        const remaining = deadlineAt - clock.now();
        if (waitMs >= remaining) {
          await clock.sleep(Math.max(remaining, 0));
          throw new RemoteTimeoutError();
        }
        await clock.sleep(waitMs);
      }
    }
    if (clock.now() >= deadlineAt) throw new RemoteTimeoutError();
    try {
      const result = await operation();
      if (clock.now() >= deadlineAt) throw new RemoteTimeoutError();
      return result;
    } finally {
      lastCallAt = clock.now();
    }
  };
}

function remotePolicy(overrides) {
  const pollMs = Math.min(60_000, Math.max(30_000, overrides.pollMs ?? 45_000));
  return {
    timeoutMs: 6 * 60 * 60 * 1000,
    outageBudgetMs: 5 * 60 * 1000,
    cleanupBudgetMs: 180_000,
    ...overrides,
    pollMs,
  };
}

async function waitForRun(lookup, { deadlineAt, policy, clock, callRemote, initialRun }) {
  let run = initialRun;
  while (true) {
    if (run?.status === 'completed') return run;
    run = await retryOperation(lookup, {
      deadlineAt,
      outageBudgetMs: policy.outageBudgetMs,
      now: clock.now,
      sleep: clock.sleep,
      callRemote,
      cadenceMs: policy.pollMs,
    });
  }
}

function validateRun(run, expectedBranch, profile = 'stream') {
  const event = profile === 'candidate' ? 'workflow_dispatch' : 'push';
  const namespace = profile === 'candidate' ? /^verify-candidate\// : /^verify\//;
  const title = `Remote agent verification (${profile}) for ${run?.head_branch}`;
  if (!run || run.event !== event || run.path !== WORKFLOW_PATH || !namespace.test(run.head_branch ?? '') || run.display_title !== title || !/^[0-9a-f]{40}$/.test(run.head_sha ?? '')) {
    throw new Error(`Attached run is not a valid remote verification ${profile} run`);
  }
  if (expectedBranch && run.head_branch !== expectedBranch) throw new Error('Attached run branch does not match the requested verification ref');
  return run;
}

function failureVerdict(sha, diagnostics, details = { jobs: [] }, profile = 'stream') {
  return { schemaVersion: 1, sha, profile, status: 'fail', jobs: details.jobs ?? [], diagnostics: [...diagnostics, ...(details.diagnostics ?? [])] };
}

function classifyError(error, sha, profile, remoteName, repo) {
  if (error instanceof RemoteTimeoutError) return { schemaVersion: 1, sha: sha ?? 'unknown', profile, status: 'timeout', jobs: [], diagnostics: [error.message] };
  if (error instanceof RemoteOutageError) return { schemaVersion: 1, sha: sha ?? 'unknown', profile, status: 'outage', jobs: [], diagnostics: [error.message] };
  if (error instanceof RemoteAuthError) return {
    schemaVersion: 1, sha: sha ?? 'unknown', profile, status: 'auth', jobs: [],
    diagnostics: [`Authentication or permission denied for remote "${remoteName}" (${repo}): ${error.message}. Run "gh auth status" and confirm this identity has push access to ${repo}.`],
  };
  if (error instanceof RemoteNotFoundError) return {
    schemaVersion: 1, sha: sha ?? 'unknown', profile, status: 'not-found', jobs: [],
    diagnostics: [`GitHub resource was not found for remote "${remoteName}" (${repo}): ${error.message}. Check "gh workflow list --repo ${repo}" and confirm the workflow exists.`],
  };
  return failureVerdict(sha ?? 'unknown', [error?.message ?? String(error)], { jobs: [] }, profile);
}

function isTypedRemoteFailure(error) {
  return error instanceof RemoteAuthError || error instanceof RemoteNotFoundError;
}

function failureDetails(jobsResponse, logTail) {
  return {
    jobs: (jobsResponse.jobs ?? []).map((job) => ({
      name: job.name,
      status: job.conclusion === 'success' ? 'pass' : job.conclusion === 'skipped' ? 'skipped' : 'fail',
      failures: (job.steps ?? []).filter((step) => step.conclusion === 'failure').map((step) => step.name),
      logTail: job.conclusion === 'success' ? '' : logTail,
    })),
  };
}

export async function runRemoteVerification(options, executors, overrides = {}) {
  if (!options?.out) throw new Error('The --out path is required');
  if (Boolean(options.attach) === Boolean(options.stream)) throw new Error('Provide exactly one stream name or --attach value');
  options = { ...options, profile: options.profile ?? 'stream' };
  const gh = executors.gh;
  const git = executors.git;
  const clock = overrides.clock ?? { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
  const policy = remotePolicy(overrides.policy ?? {});
  const deadlineAt = clock.now() + policy.timeoutMs;
  const callRemote = createRemoteCaller(clock, policy.pollMs);
  let repo;
  const remoteName = options.remote ?? 'origin';
  let remoteUrl;
  let ref;
  let sha;
  let run;
  let verdict;

  try {
    try {
      remoteUrl = await git.remoteUrl(remoteName);
    } catch (cause) {
      throw new VerificationRemoteError(remoteName, 'is not configured in this worktree', { cause });
    }
    repo = repositoryFromRemote(remoteUrl, remoteName);
    if (options.attach) {
      if (/^\d+$/.test(options.attach)) {
        run = validateRun(await retryOperation(() => gh.getRun(repo, options.attach), {
          deadlineAt, outageBudgetMs: policy.outageBudgetMs, now: clock.now, sleep: clock.sleep,
          callRemote, cadenceMs: policy.pollMs,
        }), undefined, options.profile);
        sha = run.head_sha;
        ref = run.head_branch;
        run = await waitForRun(() => gh.getRun(repo, options.attach), { deadlineAt, policy, clock, callRemote, initialRun: run });
        validateRun(run, ref, options.profile);
      } else {
        ref = options.attach;
        if (!ref.startsWith(options.profile === 'candidate' ? 'verify-candidate/' : 'verify/')) throw new Error(`An attached ref must be under ${options.profile === 'candidate' ? 'verify-candidate/' : 'verify/'}`);
        const namedSha = ref.match(/\/(?:[0-9]{8}T[0-9]{6}Z)-([0-9a-f]{40})$/)?.[1];
        if (!namedSha) throw new Error('Attached verification ref must include its timestamp and commit SHA');
        sha = await retryOperation(() => git.resolveRef(remoteName, ref), {
          deadlineAt, outageBudgetMs: policy.outageBudgetMs, now: clock.now, sleep: clock.sleep,
          callRemote, cadenceMs: policy.pollMs,
        });
        if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Attached verification ref did not resolve to a full commit SHA');
        if (sha !== namedSha) throw new Error(`Attached ref SHA mismatch: ref names ${namedSha}, remote ref resolves to ${sha}`);
        run = await waitForRun(async () => selectVerificationRun(await gh.listRuns(repo, ref, options.profile === 'candidate' ? 'workflow_dispatch' : 'push'), { branch: ref, sha, workflowPath: WORKFLOW_PATH, event: options.profile === 'candidate' ? 'workflow_dispatch' : 'push', profile: options.profile }), { deadlineAt, policy, clock, callRemote });
        validateRun(run, ref, options.profile);
      }
    } else {
      sha = await git.headSha();
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Current HEAD did not resolve to a full commit SHA');
      const created = new Date(clock.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      ref = `${options.profile === 'candidate' ? 'verify-candidate' : 'verify'}/${options.stream}/${created}-${sha}`;
      await retryOperation(() => git.pushRef(remoteName, ref, sha), {
        deadlineAt, outageBudgetMs: policy.outageBudgetMs, now: clock.now, sleep: clock.sleep,
        callRemote, cadenceMs: policy.pollMs,
      });
      if (options.profile === 'candidate') {
        const branch = await git.currentBranch();
        const baseRef = candidateIntegrationBase(branch);
        await callRemote(() => gh.dispatchRun(repo, ref, 'candidate', baseRef), deadlineAt);
      }
      run = await waitForRun(async () => selectVerificationRun(await gh.listRuns(repo, ref, options.profile === 'candidate' ? 'workflow_dispatch' : 'push'), { branch: ref, sha, workflowPath: WORKFLOW_PATH, event: options.profile === 'candidate' ? 'workflow_dispatch' : 'push', profile: options.profile }), { deadlineAt, policy, clock, callRemote });
      validateRun(run, ref, options.profile);
    }

    let artifact;
    let artifactError;
    try {
      artifact = await callRemote(() => gh.downloadVerdict(repo, run.id), deadlineAt);
    } catch (error) {
      if (error instanceof RemoteTimeoutError || isTypedRemoteFailure(error)) throw error;
      artifactError = error;
    }
    if (run.conclusion === 'timed_out') {
      verdict = { schemaVersion: 1, sha, profile: options.profile, status: 'timeout', jobs: [], diagnostics: [`GitHub Actions run ${run.id} exceeded its workflow timeout`, ...(artifactError ? [`The completed run artifact could not be fetched once: ${artifactError.message}`] : [])] };
    } else {
      try {
        if (artifactError) throw artifactError;
        const parsed = parseVerdict(artifact, sha);
        if (parsed.profile !== options.profile) throw new Error(`Remote verdict profile mismatch: expected ${options.profile}, received ${String(parsed.profile)}`);
        verdict = {
          ...parsed,
          profile: options.profile,
          jobs: parsed.jobs.map((job) => ({ ...job, failures: [...job.failures] })),
          diagnostics: [...(parsed.diagnostics ?? [])],
        };
      } catch (error) {
        if (error instanceof RemoteTimeoutError || isTypedRemoteFailure(error)) throw error;
        if (run.conclusion === 'failure') {
          try {
            const jobsResponse = await retryOperation(() => gh.failureJobs(repo, run.id), {
              deadlineAt, outageBudgetMs: policy.outageBudgetMs, now: clock.now, sleep: clock.sleep,
              callRemote, cadenceMs: policy.pollMs,
            });
            verdict = failureVerdict(sha, [`Workflow failed before a valid verdict artifact was available: ${error.message}`], failureDetails(jobsResponse, ''), options.profile);
          } catch (detailsError) {
            if (detailsError instanceof RemoteTimeoutError || detailsError instanceof RemoteOutageError || isTypedRemoteFailure(detailsError)) throw detailsError;
            verdict = failureVerdict(sha, [`Workflow failed and diagnostics could not be retrieved: ${detailsError.message}`], { jobs: [] }, options.profile);
          }
          if (error instanceof RemoteOutageError && verdict.status === 'fail') {
            verdict.diagnostics.push(`Verdict artifact retrieval failed: ${error.message}`);
          }
        } else {
          verdict = failureVerdict(sha, [`Could not retrieve a valid verdict artifact once: ${error.message}`], { jobs: [] }, options.profile);
        }
      }
      if (run.conclusion !== 'success' && verdict.status === 'pass') {
        verdict = failureVerdict(sha, [`GitHub Actions concluded ${run.conclusion}; a passing artifact cannot override that result`], { jobs: verdict.jobs }, options.profile);
      }
      if (verdict?.status !== 'pass' && verdict?.status !== 'timeout' && verdict?.status !== 'outage') {
        try {
          const jobsResponse = await retryOperation(() => gh.failureJobs(repo, run.id), {
            deadlineAt, outageBudgetMs: policy.outageBudgetMs, now: clock.now, sleep: clock.sleep,
            callRemote, cadenceMs: policy.pollMs,
          });
          const failedJobs = (jobsResponse.jobs ?? []).filter((job) => job.conclusion !== 'success');
          const logs = [];
          for (const job of failedJobs) {
            try {
              const log = await retryOperation(() => gh.failureLogs(repo, run.id, job.id), {
                deadlineAt, outageBudgetMs: policy.outageBudgetMs, now: clock.now, sleep: clock.sleep,
                callRemote, cadenceMs: policy.pollMs,
              });
              logs.push({ name: job.name, log });
            } catch (error) {
              if (error instanceof RemoteTimeoutError || error instanceof RemoteOutageError || isTypedRemoteFailure(error)) throw error;
              logs.push({ name: job.name, log: '' });
              verdict.diagnostics.push(`Failed-step log for ${job.name} could not be retrieved: ${error.message}`);
            }
          }
          verdict.jobs = verdict.jobs.map((job) => {
            const evidence = logs.find((item) => item.name === job.name);
            return evidence ? { ...job, logTail: evidence.log } : job;
          });
          for (const sourceJob of failedJobs) {
            const index = verdict.jobs.findIndex((job) => job.name === sourceJob.name);
            const status = sourceJob.conclusion === 'skipped' ? 'skipped' : 'fail';
            const failures = (sourceJob.steps ?? []).filter((step) => step.conclusion === 'failure').map((step) => step.name);
            if (index < 0) {
              verdict.jobs.push({ name: sourceJob.name, status, failures, logTail: logs.find((item) => item.name === sourceJob.name)?.log ?? '' });
            } else if (verdict.jobs[index].status === 'pass') {
              verdict.jobs[index] = { ...verdict.jobs[index], status, failures, logTail: logs.find((item) => item.name === sourceJob.name)?.log ?? '' };
            }
          }
          let structuredArtifacts = [];
          try {
            structuredArtifacts = await retryOperation(() => gh.failureArtifacts(repo, run.id), {
              deadlineAt, outageBudgetMs: policy.outageBudgetMs, now: clock.now, sleep: clock.sleep,
              callRemote, cadenceMs: policy.pollMs,
            });
          } catch (error) {
            if (error instanceof RemoteTimeoutError || error instanceof RemoteOutageError || isTypedRemoteFailure(error)) throw error;
            verdict.diagnostics.push(`Structured job findings could not be retrieved: ${error.message}`);
          }
          verdict.failureEvidence = { jobs: logs, structuredArtifacts };
        } catch (error) {
          if (error instanceof RemoteTimeoutError || error instanceof RemoteOutageError || isTypedRemoteFailure(error)) throw error;
          verdict.diagnostics.push(`Failed-job evidence could not be retrieved: ${error.message}`);
        }
      }
    }
  } catch (error) {
    verdict = classifyError(error, sha, options.profile, remoteName, repo ?? 'unknown repository');
  }

  verdict.diagnostics ??= [];
  if (ref && remoteUrl) {
    try {
      await retryOperation(() => git.deleteRef(remoteName, ref), {
        deadlineAt: clock.now() + policy.cleanupBudgetMs,
        outageBudgetMs: policy.cleanupBudgetMs,
        now: clock.now,
        sleep: clock.sleep,
        callRemote,
        cadenceMs: policy.pollMs,
      });
    } catch (error) {
      if (isTypedRemoteFailure(error)) {
        verdict = classifyError(error, sha, options.profile, remoteName, repo ?? 'unknown repository');
        return verdict;
      }
      verdict.diagnostics.push(`Verify ref cleanup failed after retries; the scheduled sweep will remove ${ref}: ${error.message}`);
    }
  }
  return verdict;
}

