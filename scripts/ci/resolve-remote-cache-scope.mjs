#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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

export function remoteCacheConfig({ scope, sha, runnerOs, runnerArch, runnerTemp, nodeVersion, goVersion }) {
  const partition = createHash('sha256').update(`${nodeVersion.trim()}\n${goVersion.trim()}\n`).digest('hex').slice(0, 16);
  const prefix = `devkit-cas-v2-${scope}-${runnerOs}-${runnerArch}-${partition}`;
  return {
    path: `${runnerTemp}/kb-devkit-cas`,
    partition,
    key: `${prefix}-${sha}`,
    restoreKey: `${prefix}-`,
  };
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
  const node = spawnSync('node', ['--version'], { encoding: 'utf8' });
  const go = spawnSync('go', ['version'], { encoding: 'utf8' });
  const mode = node.status === 0 && go.status === 0
    && process.env.RUNNER_OS && process.env.RUNNER_ARCH && process.env.RUNNER_TEMP
    ? result.mode
    : 'off';
  const config = remoteCacheConfig({
    scope: result.scope,
    sha: result.sha,
    runnerOs: process.env.RUNNER_OS || '',
    runnerArch: process.env.RUNNER_ARCH || '',
    runnerTemp: process.env.RUNNER_TEMP || '',
    nodeVersion: node.status === 0 ? node.stdout.trim() : '',
    goVersion: go.status === 0 ? go.stdout.trim() : '',
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\nscope=${result.scope}\nsha=${result.sha}\npath=${config.path}\npartition=${config.partition}\ncache_key=${config.key}\nrestore_key=${config.restoreKey}\n`);
  if (mode !== 'off') appendFileSync(process.env.GITHUB_ENV, `KBLABS_CI_DEVKIT_CAS_ROOT=${config.path}\n`);
  process.stdout.write(`devkit CAS mode: ${mode}\n`);
}
