import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, repositoryFromRemote, selectVerificationRun, terminalVerdict } from './remote-verdict.mjs';

const good = { schemaVersion: 1, sha: 'abc123', profile: 'candidate', status: 'pass', jobs: [{ name: 'build', status: 'pass', failures: [], logTail: '' }], internalToolResults: { status: 'pass', jobs: [] } };

test('accepts a verdict only for the requested SHA', () => {
  assert.equal(parseVerdict(good, 'abc123'), good);
  assert.throws(() => parseVerdict(good, 'def456'), /SHA mismatch/);
});

test('rejects pass when any job failed', () => {
  assert.throws(() => parseVerdict({ ...good, jobs: [{ name: 'build', status: 'fail', failures: ['TS failed'], logTail: 'TS failed' }] }, 'abc123'), /non-passing job/);
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

test('derives the repository from the configured SSH alias and HTTPS remotes', () => {
  assert.equal(repositoryFromRemote('git@github-kb-backup:KirillBaranovOfficial/kb-labs-backup.git'), 'KirillBaranovOfficial/kb-labs-backup');
  assert.equal(repositoryFromRemote('https://github.com/kb-labs-team/kb-labs.git'), 'kb-labs-team/kb-labs');
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
