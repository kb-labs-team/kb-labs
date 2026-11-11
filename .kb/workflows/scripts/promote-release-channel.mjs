#!/usr/bin/env node

// The workflow engine owns this transition. CI has already published exact
// candidate bytes and run smoke; this script is the only place that makes a
// release installable by moving npm dist-tags and the binary channel pointer.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platformFlowPolicies } from '../../../plugins/release/src/core/platform-flow-policy.mjs';

const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const required = name => {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
};

const candidateRunId = required('--candidate-run-id');
const candidateId = required('--candidate-id');
const flow = required('--flow');
const version = required('--version');
const channel = required('--channel');
const commit = required('--commit');
const expectedDigest = required('--expected-digest');
const repository = value('--repository') ?? process.env.GITHUB_REPOSITORY;
if (!repository) throw new Error('--repository or GITHUB_REPOSITORY is required');
if (!['canary', 'stable'].includes(channel)) throw new Error(`unsupported channel: ${channel}`);
const npmTag = channel === 'stable' ? 'latest' : 'canary';
const token = process.env.NPM_TOKEN ?? process.env.NODE_AUTH_TOKEN;
if (!token) throw new Error('NPM_TOKEN or NODE_AUTH_TOKEN is required to promote a release channel');
const flowPolicy = platformFlowPolicies[flow];
if (!flowPolicy) throw new Error(`release flow ${flow} has no candidate delivery policy`);
const deliveryTargetName = flowPolicy.channelDeliveryTargets[channel];
const deliveryTarget = flowPolicy.deliveryTargets[deliveryTargetName];
if (!deliveryTarget) throw new Error(`release flow ${flow} has no declared delivery target for ${channel}`);
const registry = deliveryTarget.registry;

const root = mkdtempSync(join(tmpdir(), 'kb-release-promotion-'));
const bundle = join(root, 'bundle');
const npmrc = join(root, '.npmrc');
const run = (command, commandArgs, options = {}) => execFileSync(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
// This script is synchronous end to end (execFileSync throughout); a blocking
// sleep via Atomics.wait keeps the dist-tag visibility retry in that same
// style instead of introducing async/await for one call site.
const sleepSync = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

try {
  run('gh', ['run', 'download', candidateRunId, '--repo', repository, '--name', `release-candidate-${candidateId}`, '--dir', bundle]);
  run('pnpm', ['--filter', '@kb-labs/release', 'build:cli']);
  const { verifyCandidateBundle } = await import('../../../plugins/release/dist/shared/candidate-bundle.js');
  const verified = verifyCandidateBundle(bundle, {
    expectedDigest,
    candidateId,
    commit,
    flow,
    version,
  }, { targetKind: deliveryTarget.kind, promotionChannel: channel });
  const artifacts = verified.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error('candidate bundle has no staged npm artifacts');
  writeFileSync(npmrc, `//${new URL(registry).host}/:_authToken=${token}\nregistry=${registry}\n`);
  const npmEnv = { ...process.env, NPM_CONFIG_USERCONFIG: npmrc };
  const previous = new Map();
  for (const artifact of artifacts) previous.set(artifact.name, distTags(artifact.name, npmEnv));

  const moved = [];
  try {
    for (const artifact of artifacts) {
      // Resume support: a previous attempt that died part-way (worker loss,
      // timeout, a straggling package) leaves some tags already at the target.
      // npm answers a repeated `dist-tag add` for an already-set tag with
      // E409 Conflict, so re-running the promotion used to fail on the first
      // package it had already moved and could never complete. A tag already
      // at the target is the desired end state, not something to move (or
      // roll back) again.
      if (previous.get(artifact.name)?.[npmTag] === artifact.version) continue;
      // `npm dist-tag add` throws (execFileSync, non-zero exit) on a genuine
      // write failure — that's the real correctness gate, and it's what the
      // catch block below rolls back for.
      try {
        run('npm', ['dist-tag', 'add', `${artifact.name}@${artifact.version}`, npmTag, '--registry', registry], { env: npmEnv });
      } catch (error) {
        // Same E409, raced inside this run: the write landed on an earlier
        // try (lost response / retry) and the retry hit the already-set tag.
        // Only accept it when the registry now really reports the target —
        // read it back with the same replication-lag patience as below: the
        // registry can answer E409 for a write it has already accepted while
        // a read right after still returns the old tag.
        let landed = false;
        for (let attempt = 0; attempt < 5 && !landed; attempt++) {
          if (attempt > 0) sleepSync(2000);
          landed = distTags(artifact.name, npmEnv)[npmTag] === artifact.version;
        }
        if (!landed) throw error;
      }
      moved.push(artifact.name);
      // The write above can succeed while a read immediately after still
      // returns the pre-write value — confirmed live (registry.npmjs.org)
      // across two separate promotions, once needing several seconds and
      // once needing longer than that. This is ordinary replication lag, not
      // a failure: the accepted write is real regardless of how long a
      // specific read takes to catch up. Warn and move on rather than treat
      // a slow read as fatal — treating it as fatal is actively harmful here:
      // it used to throw and roll back this package's tag AND every other
      // package already correctly moved earlier in this same loop, undoing
      // real work over a false alarm (confirmed live: one straggling package
      // rolled back ~166 already-correct tag moves back to the prior
      // release). A genuine write failure is still caught above by
      // `run()`/execFileSync throwing, independent of this check.
      let tags = {};
      let visible = false;
      for (let attempt = 0; attempt < 5 && !visible; attempt++) {
        if (attempt > 0) sleepSync(2000);
        tags = distTags(artifact.name, npmEnv);
        visible = tags[npmTag] === artifact.version;
      }
      if (!visible) {
        console.warn(`warning: ${artifact.name}@${npmTag} not yet visible as ${artifact.version} ` +
          `(saw ${tags[npmTag] ?? '<missing>'}) — npm dist-tag add reported success; ` +
          `this is registry replication lag, not a failed write.`);
      }
    }
  } catch (error) {
    rollbackTags(moved, previous, npmTag, npmEnv);
    throw error;
  }

  if (flow === 'platform') promoteBinaryChannel(bundle, { repository, channel, candidateId, version });
  console.log(`::kb-output::${JSON.stringify({ candidateId, flow, version, channel, npmTag, promoted: true })}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}

function distTags(packageName, env) {
  // `npm dist-tag ls --json` silently ignores --json (confirmed live on
  // npm 11.16.0: prints the same plain "tag: version" lines either way) and
  // JSON.parse-ing that output throws. `npm view <pkg> dist-tags --json`
  // requests the identical data and actually honors --json.
  return JSON.parse(run('npm', ['view', packageName, 'dist-tags', '--json', '--registry', registry], { env }) || '{}');
}

function rollbackTags(packages, previous, tag, env) {
  for (const packageName of packages.reverse()) {
    try {
      const prior = previous.get(packageName)?.[tag];
      if (prior) run('npm', ['dist-tag', 'add', `${packageName}@${prior}`, tag, '--registry', registry], { env });
      else run('npm', ['dist-tag', 'rm', packageName, tag, '--registry', registry], { env });
    } catch { /* best effort; the workflow failure preserves the evidence */ }
  }
}

function promoteBinaryChannel(bundleDir, { repository, channel, candidateId, version }) {
  const indexDigest = createHash('sha256').update(readFileSync(join(bundleDir, 'release-index.json'))).digest('hex');
  const pointer = join(bundleDir, 'channel.json');
  const tag = `v${version}-binaries`;
  writeFileSync(pointer, `${JSON.stringify({ schema: 2, channel, tag, candidateId, indexDigest }, null, 2)}\n`);
  const channelRelease = `binaries-${channel}`;
  try {
    run('gh', ['release', 'upload', channelRelease, pointer, '--repo', repository, '--clobber']);
  } catch {
    run('gh', ['release', 'create', channelRelease, pointer, '--repo', repository, '--title', `KB Labs binaries ${channel} channel`, '--notes', 'Managed by the release workflow engine after verified candidate smoke.']);
  }
}
