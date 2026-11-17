#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export function journeyCacheScope({ checkoutSha, workflowSha, baseSha, cacheAllowed = false }) {
  if (!cacheAllowed || !/^[0-9a-f]{40}$/i.test(checkoutSha ?? '') || checkoutSha.toLowerCase() !== (workflowSha ?? '').toLowerCase() || !/^[0-9a-f]{40}$/i.test(baseSha ?? '')) {
    return { mode: 'off', scope: 'uncacheable', sha: /^[0-9a-f]{40}$/i.test(checkoutSha ?? '') ? checkoutSha.toLowerCase() : 'uncacheable' };
  }
  return { mode: 'read-write', scope: `journey-${baseSha.toLowerCase()}`, sha: checkoutSha.toLowerCase() };
}

export function isTrustedJourneyCacheInvocation({ eventName, workflowRef, repository, ref }) {
  const expectedWorkflowRef = `${repository || ''}/.github/workflows/journey-batch.yml@${ref || ''}`;
  return ['push', 'workflow_dispatch'].includes(eventName) && workflowRef === expectedWorkflowRef;
}

if (process.argv[1]?.endsWith('resolve-journey-cache-scope.mjs')) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const base = spawnSync('git', ['merge-base', process.env.KB_DEVKIT_BASE_REF || '', 'HEAD'], { encoding: 'utf8' });
  const cacheAllowed = isTrustedJourneyCacheInvocation({
    eventName: process.env.GITHUB_EVENT_NAME,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
  });
  const result = journeyCacheScope({
    checkoutSha: head.status === 0 ? head.stdout.trim() : '',
    workflowSha: process.env.GITHUB_SHA || '',
    baseSha: base.status === 0 ? base.stdout.trim() : '',
    cacheAllowed,
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `mode=${result.mode}\nscope=${result.scope}\nsha=${result.sha}\n`);
  process.stdout.write(`devkit CAS mode: ${result.mode}\n`);
}
