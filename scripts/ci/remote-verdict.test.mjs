import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, repositoryFromRemote, selectVerificationRun, terminalVerdict, VerificationRemoteError } from './remote-verdict.mjs';

const good = { schemaVersion: 1, sha: 'abc123', profile: 'candidate', status: 'pass', jobs: [{ name: 'build', status: 'pass', failures: [], logTail: '' }], internalToolResults: { status: 'pass', jobs: [] } };

test('accepts a verdict only for the requested SHA', () => {
  assert.equal(parseVerdict(good, 'abc123'), good);
  assert.throws(() => parseVerdict(good, 'def456'), /SHA mismatch/);
});

test('rejects pass when any job failed', () => {
  assert.throws(() => parseVerdict({ ...good, jobs: [{ name: 'build', status: 'fail', failures: ['TS failed'], logTail: 'TS failed' }] }, 'abc123'), /non-passing job/);
});

test('platform partial requires a complete exclusion manifest and cannot be labeled pass', () => {
  const scope = { name: 'platform', status: 'partial', excludedPackages: ['kb-runner'], excludedChecks: ['internal-tool build', 'internal-tool test', 'internal-tool package checks'], warning: 'Scope is partial.' };
  const platform = { ...good, profile: 'platform', status: 'partial', scope, selection: { packages: ['@kb-labs/core'] }, internalToolResults: { status: 'pass', jobs: [] }, jobs: [
    { name: 'ci-script-suite', status: 'pass', failures: [], logTail: '' },
  ] };
  assert.equal(parseVerdict(platform, 'abc123').status, 'partial');
  assert.throws(() => parseVerdict({ ...platform, scope: undefined }, 'abc123'), /exclusion manifest/);
  assert.throws(() => parseVerdict({ ...platform, status: 'pass' }, 'abc123'), /full pass/);
  assert.throws(() => parseVerdict({ ...good, status: 'partial' }, 'abc123'), /Only the platform/);
});

test('candidate verdict requires internal-tool results', () => {
  const { internalToolResults, ...omitted } = good;
  assert.throws(() => parseVerdict(omitted, 'abc123'), /internal-tool results are required/);
});

test('classifies bounded wait expiry and API outages distinctly', () => {
  assert.equal(terminalVerdict('abc123', 'timeout', 'run wait expired').status, 'timeout');
  assert.equal(terminalVerdict('abc123', 'outage', 'GitHub API unavailable').status, 'outage');
  assert.throws(() => terminalVerdict('abc123', 'pass', 'unexpected'), /Invalid terminal/);
});

test('derives the repository from GitHub SSH and HTTPS remotes', () => {
  assert.equal(repositoryFromRemote('git@github.com:kb-labs-team/kb-labs.git'), 'kb-labs-team/kb-labs');
  assert.equal(repositoryFromRemote('https://github.com/kb-labs-team/kb-labs.git'), 'kb-labs-team/kb-labs');
});

test('rejects a non-GitHub remote with a typed, actionable diagnostic naming that remote', () => {
  assert.throws(
    () => repositoryFromRemote('https://example.com/kb-labs-team/kb-labs.git', 'origin'),
    (error) => error instanceof VerificationRemoteError && error.code === 'VERIFICATION_REMOTE_INVALID' && /origin/.test(error.message) && /GitHub/.test(error.message),
  );
});

test('selects only the push run for the exact branch, workflow, and SHA', () => {
  const runs = [
    { id: 1, event: 'push', head_branch: 'verify/stream', head_sha: 'other', path: '.github/workflows/remote-verify.yml' },
    { id: 2, event: 'workflow_dispatch', head_branch: 'verify/stream', head_sha: 'abc123', path: '.github/workflows/remote-verify.yml' },
    { id: 3, event: 'push', head_branch: 'verify/other', head_sha: 'abc123', path: '.github/workflows/remote-verify.yml' },
    { id: 4, event: 'push', head_branch: 'verify/stream', head_sha: 'abc123', path: '.github/workflows/other.yml' },
    { id: 5, event: 'push', head_branch: 'verify/stream', head_sha: 'abc123', path: '.github/workflows/remote-verify.yml', display_title: 'Remote agent verification (stream) for verify/stream' },
  ];
  assert.equal(selectVerificationRun(runs, { branch: 'verify/stream', sha: 'abc123', workflowPath: '.github/workflows/remote-verify.yml' }).id, 5);
});
