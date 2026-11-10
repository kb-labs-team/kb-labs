import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteAuthError, RemoteNotFoundError, RemoteOperationError, runRemoteVerification } from './remote-verify-core.mjs';
import { createGitRemoteOperations } from './remote-verify-git.mjs';
import { classifyRemoteCliError } from './remote-verify-errors.mjs';

const sha = 'a'.repeat(40);
const pass = { schemaVersion: 1, sha, profile: 'stream', status: 'pass', jobs: [{ name: 'build', status: 'pass', failures: [], logTail: '' }] };
const candidatePass = { ...pass, profile: 'candidate', internalToolResults: { status: 'pass', jobs: [] } };
const run = (overrides = {}) => { const head_branch = overrides.head_branch ?? 'verify/stream/20261025T120000Z-' + sha; return { id: 17, event: 'push', head_branch, head_sha: sha, path: '.github/workflows/remote-verify.yml', display_title: `Remote agent verification (stream) for ${head_branch}`, status: 'completed', conclusion: 'success', ...overrides }; };

function harness({ listRuns, getRun, downloadVerdict = async () => pass, pushRef = async () => {}, deleteRef = async () => {}, resolveRef = async () => sha, remoteUrl = 'https://github.com/kb-labs-team/kb-labs.git', remoteUrlError, failureJobs = async () => ({ jobs: [] }), failureLogs = async () => '', failureArtifacts = async () => [] } = {}) {
  let time = 0;
  const calls = { pushes: [], resolves: [], deletes: [], remoteUrls: [], repositories: [], lists: 0, gets: 0, ghTimes: [], remoteTimes: [], artifacts: 0 };
  const recordGh = () => { calls.ghTimes.push(time); calls.remoteTimes.push(time); };
  const recordGitRemote = () => calls.remoteTimes.push(time);
  const gh = {
    listRuns: async (...args) => { recordGh(); calls.lists += 1; calls.repositories.push(args[0]); return listRuns ? listRuns(...args) : [run({ head_branch: args[1] })]; },
    dispatchRun: async () => { recordGh(); },
    getRun: async (...args) => { recordGh(); calls.gets += 1; return getRun ? getRun(...args) : run(); },
    downloadVerdict: async (...args) => { recordGh(); calls.artifacts += 1; return downloadVerdict(...args); },
    failureJobs: async (...args) => { recordGh(); return failureJobs(...args); },
    failureLogs: async (...args) => { recordGh(); return failureLogs(...args); },
    failureArtifacts: async (...args) => { recordGh(); return failureArtifacts(...args); },
  };
  const git = {
    headSha: async () => sha,
    currentBranch: async () => 'agent/x231-test-strategy',
    remoteUrl: async (remoteName) => { calls.remoteUrls.push(remoteName); if (remoteUrlError) throw remoteUrlError; return remoteUrl; },
    pushRef: async (remoteName, ref, pushedSha) => { recordGitRemote(); calls.pushes.push({ remote: remoteName, ref, sha: pushedSha }); return pushRef(remoteName, ref, pushedSha); },
    resolveRef: async (remoteName, ref) => { recordGitRemote(); calls.resolves.push({ remote: remoteName, ref }); return resolveRef(remoteName, ref); },
    deleteRef: async (remoteName, ref) => { recordGitRemote(); calls.deletes.push({ remote: remoteName, ref }); return deleteRef(remoteName, ref); },
  };
  const clock = { now: () => time, sleep: async (ms) => { time += ms; } };
  return { executors: { gh, git }, clock, calls, policy: { timeoutMs: 300_000, outageBudgetMs: 120_000, cleanupBudgetMs: 180_000 } };
}

test('Git adapter sends the same configured remote to push, lookup, and delete commands', async () => {
  const commands = [];
  const operations = createGitRemoteOperations((command, args) => {
    commands.push({ command, args });
    return `${sha}\trefs/heads/verify/stream`;
  }, RemoteOperationError, RemoteNotFoundError);
  await operations.pushRef('origin', 'verify/stream', sha);
  assert.equal(await operations.resolveRef('origin', 'verify/stream'), sha);
  await operations.deleteRef('origin', 'verify/stream');
  assert.deepEqual(commands.map(({ args }) => args.slice(4, 6)), [
    ['push', 'origin'],
    ['ls-remote', 'origin'],
    ['push', 'origin'],
  ]);
  for (const { command, args } of commands) {
    assert.equal(command, 'git');
    assert.deepEqual(args.slice(0, 4), ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']);
  }
});

// case: S-262.10
test('a git permission denial returns an auth verdict immediately with a recovery step', async () => {
  let attempts = 0;
  const h = harness({
    pushRef: async () => { attempts += 1; throw classifyRemoteCliError('git', 'remote: Permission to kb-labs-team/kb-labs.git denied', { retryable: true }); },
  });
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'auth');
  assert.equal(attempts, 1);
  assert.match(verdict.diagnostics.join('\n'), /origin/);
  assert.match(verdict.diagnostics.join('\n'), /kb-labs-team\/kb-labs/);
  assert.match(verdict.diagnostics.join('\n'), /gh auth status/);
  assert.match(verdict.diagnostics.join('\n'), /push access/);
});

// case: S-262.10
test('a git permission denial while deleting the verification ref replaces a pass with auth', async () => {
  const h = harness({ deleteRef: async () => { throw new RemoteAuthError('Authentication failed while deleting the verification ref'); } });
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'auth');
  assert.match(verdict.diagnostics.join('\n'), /gh auth status/);
  assert.equal(h.calls.deletes.length, 1);
});

// case: S-262.11
test('a GitHub API permission denial is typed and is not retried', async () => {
  let attempts = 0;
  const h = harness({ listRuns: async () => { attempts += 1; throw classifyRemoteCliError('gh', 'HTTP 403: Resource not accessible by integration', { retryable: true }); } });
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'auth');
  assert.equal(attempts, 1);
  assert.match(verdict.diagnostics.join('\n'), /kb-labs-team\/kb-labs/);
  assert.match(verdict.diagnostics.join('\n'), /gh auth status/);
});

// case: S-262.11
test('an empty successful ls-remote result returns not-found without retrying', async () => {
  let attempts = 0;
  const git = createGitRemoteOperations(() => { attempts += 1; return ''; }, RemoteOperationError, RemoteNotFoundError);
  const h = harness({ resolveRef: (remote, ref) => git.resolveRef(remote, ref) });
  const verdict = await runRemoteVerification({ attach: `verify/stream/20261025T120000Z-${sha}`, out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'not-found');
  assert.equal(attempts, 1);
});

test('a failed ls-remote transport remains retryable', async () => {
  const operations = createGitRemoteOperations(() => { throw new RemoteOperationError('connection reset', { retryable: true }); }, RemoteOperationError, RemoteNotFoundError);
  await assert.rejects(operations.resolveRef('origin', 'verify/stream'), (error) => error.retryable === true);
});

test('a missing GitHub workflow resource is reported as not-found rather than outage', async () => {
  let attempts = 0;
  const h = harness({ listRuns: async () => { attempts += 1; throw classifyRemoteCliError('gh', 'HTTP 404: workflow remote-verify.yml not found', { retryable: true }); } });
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'not-found');
  assert.equal(attempts, 1);
  assert.match(verdict.diagnostics.join('\n'), /kb-labs-team\/kb-labs/);
  assert.match(verdict.diagnostics.join('\n'), /gh workflow list --repo kb-labs-team\/kb-labs/);
});

// case: S-262.12
test('transient server and connection failures are retried', async () => {
  let attempts = 0;
  const h = harness({ listRuns: async (_repo, branch) => {
    attempts += 1;
    if (attempts === 1) throw new RemoteOperationError('HTTP 503 service unavailable', { retryable: true });
    if (attempts === 2) throw new RemoteOperationError('connection reset by peer', { retryable: true });
    return [run({ head_branch: branch })];
  } });
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'pass');
  assert.equal(attempts, 3);
});

test('CLI HTTP 403 and 404 failures are typed while 5xx and connection resets remain retryable', () => {
  assert.ok(classifyRemoteCliError('git', 'remote: Permission to kb-labs-team/kb-labs.git denied', { retryable: true }) instanceof RemoteAuthError);
  assert.ok(classifyRemoteCliError('gh', 'HTTP 403: Resource not accessible by integration', { retryable: true }) instanceof RemoteAuthError);
  assert.ok(classifyRemoteCliError('gh', 'HTTP 404: workflow remote-verify.yml not found', { retryable: true }) instanceof RemoteNotFoundError);
  assert.equal(classifyRemoteCliError('gh', 'HTTP 503: service unavailable', { retryable: true }).retryable, true);
  assert.equal(classifyRemoteCliError('git', 'connection reset by peer', { retryable: true }).retryable, true);
});

// case: S-262.6
test('resolves origin once and uses it for push, ref lookup, repository derivation, and cleanup', async () => {
  const h = harness();
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'pass', JSON.stringify(verdict));
  assert.deepEqual(h.calls.remoteUrls, ['origin']);
  assert.equal(h.calls.pushes[0].remote, 'origin');
  assert.equal(h.calls.pushes[0].sha, sha);
  assert.deepEqual(h.calls.deletes[0], { remote: 'origin', ref: h.calls.pushes[0].ref });
  assert.equal(h.calls.repositories[0], 'kb-labs-team/kb-labs');

  const attached = harness();
  const ref = `verify/stream/20261110T120000Z-${sha}`;
  const attachedVerdict = await runRemoteVerification({ attach: ref, out: '/tmp/verdict.json' }, attached.executors, { clock: attached.clock, policy: attached.policy });
  assert.equal(attachedVerdict.status, 'pass', JSON.stringify(attachedVerdict));
  assert.deepEqual(attached.calls.remoteUrls, ['origin']);
  assert.deepEqual(attached.calls.resolves[0], { remote: 'origin', ref });
  assert.deepEqual(attached.calls.deletes[0], { remote: 'origin', ref });
  assert.equal(attached.calls.repositories[0], 'kb-labs-team/kb-labs');
});

// case: S-262.6
test('uses one explicitly configured remote for the whole verification', async () => {
  const h = harness();
  const verdict = await runRemoteVerification({ stream: 'stream', remote: 'upstream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'pass', JSON.stringify(verdict));
  assert.deepEqual(h.calls.remoteUrls, ['upstream']);
  assert.equal(h.calls.pushes[0].remote, 'upstream');
  assert.deepEqual(h.calls.deletes[0], { remote: 'upstream', ref: h.calls.pushes[0].ref });
  assert.equal(h.calls.repositories[0], 'kb-labs-team/kb-labs');
});

// case: S-262.6
test('fails with an actionable diagnostic when the selected remote is missing', async () => {
  const h = harness({ remoteUrlError: new Error('No such remote') });
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'fail');
  assert.match(verdict.diagnostics[0], /\[VERIFICATION_REMOTE_INVALID\] Verification remote "origin" is not configured/);
  assert.match(verdict.diagnostics[0], /--remote <name>/);
  assert.deepEqual(h.calls.remoteUrls, ['origin']);
  assert.equal(h.calls.pushes.length, 0);
});

function assertMinimumRemoteSpacing(times, minimumMs = 30_000) {
  for (let index = 1; index < times.length; index += 1) {
    assert.ok(times[index] - times[index - 1] >= minimumMs, `remote calls were ${times[index] - times[index - 1]}ms apart: ${times}`);
  }
}

// case: S-262.6
test('a transient GitHub poll failure retries and the recovered run can pass', async () => {
  const h = harness({ listRuns: (() => { let calls = 0; return async (_repo, branch) => { calls += 1; if (calls === 1) throw new RemoteOperationError('GitHub API request failed', { retryable: true }); return [run({ head_branch: branch })]; }; })() });
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'pass', JSON.stringify(verdict));
  assert.equal(h.calls.lists, 2);
  assert.equal(h.calls.pushes.length, 1);
  assertMinimumRemoteSpacing(h.calls.remoteTimes);
});

// case: S-262.7
test('candidate requests one dispatch run on its isolated ref and records the profile', async () => {
  const candidateRun = (branch) => run({ event: 'workflow_dispatch', head_branch: branch, display_title: `Remote agent verification (candidate) for ${branch}` });
  let dispatched = 0;
  const h = harness({
    downloadVerdict: async () => candidatePass,
    listRuns: async (_repo, branch, event) => { assert.equal(event, 'workflow_dispatch'); return [candidateRun(branch)]; },
  });
  h.executors.gh.dispatchRun = async (_repo, ref, profile, baseRef) => { dispatched += 1; assert.match(ref, /^verify-candidate\//); assert.equal(profile, 'candidate'); assert.equal(baseRef, 'origin/agent/j90-integration'); };
  const verdict = await runRemoteVerification({ stream: 'release', profile: 'candidate', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'pass');
  assert.equal(verdict.profile, 'candidate');
  assert.equal(dispatched, 1);
  assert.equal(h.calls.pushes.length, 1);
  assert.equal(h.calls.deletes.length, 1);
});

test('persistent GitHub failures exhaust the outage budget and classify as outage', async () => {
  const h = harness({ listRuns: async () => { throw new RemoteOperationError('transport unavailable', { retryable: true }); } });
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: { ...h.policy, timeoutMs: 600_000, outageBudgetMs: 300_000 } });
  assert.equal(verdict.status, 'outage');
  assert.equal(h.calls.deletes.length, 1);
  assertMinimumRemoteSpacing(h.calls.remoteTimes);
  for (let index = 1; index < h.calls.ghTimes.length; index += 1) {
    const gap = h.calls.ghTimes[index] - h.calls.ghTimes[index - 1];
    assert.ok(gap >= 30_000 && gap <= 60_000, `retry gap was ${gap}ms: ${h.calls.ghTimes}`);
  }
});

test('an empty run queue at the overall deadline classifies as timeout', async () => {
  const h = harness({ listRuns: async () => [] });
  h.policy.timeoutMs = 2500;
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'timeout');
});

// case: S-262.6
test('a GitHub run conclusion of timed_out classifies as timeout', async () => {
  const h = harness({ listRuns: async () => [run({ conclusion: 'timed_out' })] });
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'timeout');
});

// case: S-262.6
test('reattaching by run ID does not push and binds the artifact to run head_sha', async () => {
  let lookups = 0;
  const h = harness({ getRun: async () => { lookups += 1; return run({ status: lookups === 1 ? 'in_progress' : 'completed' }); } });
  const verdict = await runRemoteVerification({ attach: '17', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'pass');
  assert.equal(h.calls.pushes.length, 0);
  assert.equal(h.calls.gets, 2);
  assertMinimumRemoteSpacing(h.calls.remoteTimes);
  assert.equal(h.calls.artifacts, 1);
});

// case: S-262.6
test('reattaching by verify ref resolves its SHA, selects that push run, and does not push', async () => {
  const ref = `verify/stream/20261025T120000Z-${sha}`;
  const h = harness({
    listRuns: async (_repo, branch) => [run({ head_branch: branch })],
    resolveRef: async (_remote, requestedRef) => {
      assert.equal(requestedRef, ref);
      return sha;
    },
  });
  const verdict = await runRemoteVerification({ attach: ref, out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'pass');
  assert.equal(h.calls.pushes.length, 0);
  assert.equal(h.calls.lists, 1);
  assertMinimumRemoteSpacing(h.calls.remoteTimes);
  assert.equal(h.calls.artifacts, 1);
});

// case: S-262.6
test('persistent ref cleanup failure is retried and remains a non-fatal diagnostic', async () => {
  let deletes = 0;
  const h = harness({ deleteRef: async () => { deletes += 1; throw new RemoteOperationError('git transport reset', { retryable: true }); } });
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'pass');
  assert.ok(deletes > 1);
  assertMinimumRemoteSpacing(h.calls.remoteTimes);
  assert.match(verdict.diagnostics.join('\n'), /scheduled sweep/);
});

// case: S-262.6
test('cleanup retries a transient failure and succeeds without a warning', async () => {
  let deletes = 0;
  const h = harness({ deleteRef: async () => { deletes += 1; if (deletes === 1) throw new RemoteOperationError('connection reset', { retryable: true }); } });
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'pass');
  assert.equal(deletes, 2);
  assertMinimumRemoteSpacing(h.calls.remoteTimes);
  assert.deepEqual(verdict.diagnostics, [], `deletes=${deletes}, fakeTime=${h.clock.now()}`);
});

// case: S-262.6
test('poll and retry cadence clamp to 30–60 seconds and default to 45 seconds', async () => {
  const cases = [
    { requested: undefined, expected: 45_000 },
    { requested: 1_000, expected: 30_000 },
    { requested: 90_000, expected: 60_000 },
  ];
  for (const { requested, expected } of cases) {
    const h = harness({ listRuns: (() => { let count = 0; return async (_repo, branch) => { count += 1; return count === 1 ? [] : [run({ head_branch: branch })]; }; })() });
    const policy = { ...h.policy, ...(requested === undefined ? {} : { pollMs: requested }) };
    const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy });
    assert.equal(verdict.status, 'pass');
    assert.equal(h.calls.ghTimes[1] - h.calls.ghTimes[0], expected);
    assertMinimumRemoteSpacing(h.calls.remoteTimes);
    assert.equal(h.calls.artifacts, 1);
  }
});

// case: S-262.6
test('API calls remain bounded by the deadline and minimum cadence', async () => {
  let polls = 0;
  const h = harness({ listRuns: async () => { polls += 1; if (polls > 10) throw new Error('fake clock did not advance between calls'); return []; } });
  const timeoutMs = 180_000;
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, {
    clock: h.clock,
    policy: { ...h.policy, timeoutMs, pollMs: 30_000 },
  });
  assert.equal(verdict.status, 'timeout');
  assert.ok(h.calls.ghTimes.length <= Math.ceil(timeoutMs / 30_000), `API calls=${h.calls.ghTimes.length}, times=${h.calls.ghTimes}`);
  assertMinimumRemoteSpacing(h.calls.remoteTimes);
});

// case: S-262.6
test('default cleanup budget permits retrying a transient delete failure', async () => {
  let deletes = 0;
  const h = harness({ deleteRef: async () => { deletes += 1; if (deletes === 1) throw new RemoteOperationError('connection reset', { retryable: true }); } });
  const { cleanupBudgetMs: _omitted, ...policy } = h.policy;
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy });
  assert.equal(verdict.status, 'pass');
  assert.equal(deletes, 2);
  assert.deepEqual(verdict.diagnostics, []);
});

// case: S-262.6
test('an artifact SHA mismatch cannot produce a passing verdict', async () => {
  const h = harness({ downloadVerdict: async () => ({ ...pass, sha: 'b'.repeat(40) }) });
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'fail');
  assert.match(verdict.diagnostics.join('\n'), /SHA mismatch/);
});

// case: S-262.6
test('a failed run fetches its artifact once and spaces both diagnostics calls', async () => {
  const h = harness({
    listRuns: async (_repo, branch) => [run({ head_branch: branch, conclusion: 'failure' })],
    downloadVerdict: async () => { throw new RemoteOperationError('artifact unavailable', { retryable: true }); },
    failureJobs: async () => ({ jobs: [{ name: 'unit', conclusion: 'failure', steps: [{ name: 'test example', conclusion: 'failure' }] }] }),
    failureLogs: async () => 'bounded failure log',
  });
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'fail');
  assert.equal(h.calls.artifacts, 1);
  assert.deepEqual(verdict.jobs[0].failures, ['test example']);
  assert.equal(verdict.jobs[0].logTail, 'bounded failure log');
  assert.deepEqual(verdict.failureEvidence.jobs, [{ name: 'unit', log: 'bounded failure log' }]);
  assertMinimumRemoteSpacing(h.calls.remoteTimes);
});

test('a nonpassing verdict retains job logs and structured artifacts even when a job is continue-on-error', async () => {
  const failed = { ...pass, status: 'fail', jobs: [{ name: 'internal-tool', status: 'fail', failures: ['Run tool suite'], logTail: '' }] };
  const h = harness({
    downloadVerdict: async () => failed,
    failureJobs: async () => ({ jobs: [{ id: 42, name: 'internal-tool', conclusion: 'failure', steps: [{ name: 'Run tool suite', conclusion: 'failure' }] }] }),
    failureLogs: async (_repo, _runId, jobId) => { assert.equal(jobId, 42); return 'failed tool log'; },
    failureArtifacts: async () => [{ name: 'remote-result-internal-tool-1/result.json', content: '{"findings":[]}' }],
  });
  const verdict = await runRemoteVerification({ stream: 'stream', out: '/tmp/verdict.json' }, h.executors, { clock: h.clock, policy: h.policy });
  assert.equal(verdict.status, 'fail');
  assert.deepEqual(verdict.failureEvidence.jobs, [{ name: 'internal-tool', log: 'failed tool log' }]);
  assert.deepEqual(verdict.failureEvidence.structuredArtifacts, [{ name: 'remote-result-internal-tool-1/result.json', content: '{"findings":[]}' }]);
});
