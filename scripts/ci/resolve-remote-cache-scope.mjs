#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export function resolveRemoteCacheScope({ actualSha, requestedSha, profile, selectionBaseSha, upstreamMode = 'read-write', cacheAllowed = false }) {
  const sha = /^[0-9a-f]{40}$/i.test(actualSha ?? '') ? actualSha.toLowerCase() : '';
  const requested = /^[0-9a-f]{40}$/i.test(requestedSha ?? '') ? requestedSha.toLowerCase() : '';
  const base = /^[0-9a-f]{40}$/i.test(selectionBaseSha ?? '') ? selectionBaseSha.toLowerCase() : '';
  if (!cacheAllowed || upstreamMode === 'off' || !sha || sha !== requested || !['stream', 'candidate'].includes(profile) || !base) {
    return { mode: 'off', scope: 'uncacheable', sha: sha || 'uncacheable' };
  }
  return { mode: 'read-write', scope: `remote-${profile}-${base}`, sha };
}

export function isTrustedRemoteCacheInvocation({ eventName, workflowRef, repository, ref }) {
  const expectedWorkflowRef = `${repository || ''}/.github/workflows/remote-verify.yml@${ref || ''}`;
  return ['push', 'workflow_dispatch'].includes(eventName) && workflowRef === expectedWorkflowRef;
}

if (process.argv[1]?.endsWith('resolve-remote-cache-scope.mjs')) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const cacheAllowed = isTrustedRemoteCacheInvocation({
    eventName: process.env.GITHUB_EVENT_NAME,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
  });
  const result = resolveRemoteCacheScope({
    actualSha: head.status === 0 ? head.stdout.trim() : '',
    requestedSha: process.env.REMOTE_REQUESTED_SHA || '',
    profile: process.env.REMOTE_PROFILE || '',
    selectionBaseSha: process.env.REMOTE_SELECTION_BASE_SHA || '',
    upstreamMode: process.env.REMOTE_UPSTREAM_CACHE_MODE || 'read-write',
    cacheAllowed,
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `mode=${result.mode}\nscope=${result.scope}\nsha=${result.sha}\n`);
  process.stdout.write(`devkit CAS mode: ${result.mode}\n`);
}
