import assert from 'node:assert/strict';
import test from 'node:test';
import { isTrustedRemoteCacheInvocation, remoteCacheConfig, resolveRemoteCacheScope } from './resolve-remote-cache-scope.mjs';

test('remote cache scope binds the actual target SHA, profile, and resolved selection base', () => {
  const sha = 'c'.repeat(40);
  const base = 'b'.repeat(40);
  assert.deepEqual(resolveRemoteCacheScope({ actualSha: sha, requestedSha: sha, profile: 'stream', selectionBaseSha: base, cacheAllowed: true }), {
    mode: 'read-write', scope: `remote-stream-${base}`, sha,
  });
  assert.notEqual(
    resolveRemoteCacheScope({ actualSha: sha, requestedSha: sha, profile: 'stream', selectionBaseSha: base, cacheAllowed: true }).scope,
    resolveRemoteCacheScope({ actualSha: sha, requestedSha: sha, profile: 'candidate', selectionBaseSha: base, cacheAllowed: true }).scope,
  );
  assert.notEqual(
    resolveRemoteCacheScope({ actualSha: sha, requestedSha: sha, profile: 'stream', selectionBaseSha: base, cacheAllowed: true }).scope,
    resolveRemoteCacheScope({ actualSha: sha, requestedSha: sha, profile: 'stream', selectionBaseSha: 'a'.repeat(40), cacheAllowed: true }).scope,
  );
});

test('remote cache is disabled for target mismatch, missing base, or invalid profile', () => {
  const sha = 'c'.repeat(40);
  const base = 'b'.repeat(40);
  for (const selection of [
    { actualSha: sha, requestedSha: 'd'.repeat(40), profile: 'stream', selectionBaseSha: base, cacheAllowed: true },
    { actualSha: sha, requestedSha: sha, profile: 'stream', selectionBaseSha: '', cacheAllowed: true },
    { actualSha: sha, requestedSha: sha, profile: 'other', selectionBaseSha: base, cacheAllowed: true },
  ]) {
    assert.equal(resolveRemoteCacheScope(selection).mode, 'off');
    assert.equal(resolveRemoteCacheScope(selection).scope, 'uncacheable');
  }
});

test('a producer disabled by prepare stays disabled in matching downstream checkouts', () => {
  const sha = 'c'.repeat(40);
  const result = resolveRemoteCacheScope({
    actualSha: sha,
    requestedSha: sha,
    profile: 'stream',
    selectionBaseSha: 'b'.repeat(40),
    upstreamMode: 'off',
    cacheAllowed: true,
  });
  assert.deepEqual(result, { mode: 'off', scope: 'uncacheable', sha });
});

test('remote cache is fail-closed for reusable workflow callers without a direct workflow identity', () => {
  const sha = 'c'.repeat(40);
  assert.equal(resolveRemoteCacheScope({
    actualSha: sha,
    requestedSha: sha,
    profile: 'candidate',
    selectionBaseSha: 'b'.repeat(40),
  }).mode, 'off');
});

test('remote cache trust is limited to direct push or dispatch of this workflow', () => {
  const identity = {
    eventName: 'push',
    workflowRef: 'kb-labs-team/kb-labs/.github/workflows/remote-verify.yml@refs/heads/verify/run',
    repository: 'kb-labs-team/kb-labs',
    ref: 'refs/heads/verify/run',
  };
  assert.equal(isTrustedRemoteCacheInvocation(identity), true);
  assert.equal(isTrustedRemoteCacheInvocation({ ...identity, eventName: 'workflow_call' }), false);
  assert.equal(isTrustedRemoteCacheInvocation({ ...identity, workflowRef: 'kb-labs-team/kb-labs/.github/workflows/release-build-candidate.yml@refs/heads/develop' }), false);
});

test('remote writer and readers share one versioned runner-toolchain cache key', () => {
  const config = remoteCacheConfig({
    scope: 'remote-stream-b',
    sha: 'c'.repeat(40),
    runnerOs: 'Linux',
    runnerArch: 'X64',
    runnerTemp: '/runner/temp',
    nodeVersion: 'v24.11.0',
    goVersion: 'go version go1.26.8 linux/amd64',
  });
  assert.match(config.key, /^devkit-cas-v2-remote-stream-b-Linux-X64-[0-9a-f]{16}-c{40}$/);
  assert.match(config.restoreKey, /^devkit-cas-v2-remote-stream-b-Linux-X64-[0-9a-f]{16}-$/);
  assert.equal(config.path, '/runner/temp/kb-devkit-cas');
});
