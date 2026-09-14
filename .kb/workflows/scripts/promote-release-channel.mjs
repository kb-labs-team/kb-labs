#!/usr/bin/env node

// The workflow engine owns this transition. CI has already published exact
// candidate bytes and run smoke; this script is the only place that makes a
// release installable by moving npm dist-tags and the binary channel pointer.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const repository = value('--repository') ?? process.env.GITHUB_REPOSITORY;
const registry = value('--registry') ?? 'https://registry.npmjs.org';
if (!repository) throw new Error('--repository or GITHUB_REPOSITORY is required');
if (!['canary', 'stable'].includes(channel)) throw new Error(`unsupported channel: ${channel}`);
const npmTag = channel === 'stable' ? 'latest' : 'canary';
const token = process.env.NPM_TOKEN ?? process.env.NODE_AUTH_TOKEN;
if (!token) throw new Error('NPM_TOKEN or NODE_AUTH_TOKEN is required to promote a release channel');

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
  verifyBundle(bundle, { candidateId, flow, version });
  const artifacts = JSON.parse(readFileSync(join(bundle, 'npm', 'manifest.json'), 'utf8'));
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error('candidate bundle has no staged npm artifacts');
  writeFileSync(npmrc, `//${new URL(registry).host}/:_authToken=${token}\nregistry=${registry}\n`);
  const npmEnv = { ...process.env, NPM_CONFIG_USERCONFIG: npmrc };
  const previous = new Map();
  for (const artifact of artifacts) previous.set(artifact.name, distTags(artifact.name, npmEnv));

  const moved = [];
  try {
    for (const artifact of artifacts) {
      run('npm', ['dist-tag', 'add', `${artifact.name}@${artifact.version}`, npmTag, '--registry', registry], { env: npmEnv });
      // The registry write above can succeed while a read immediately after
      // still returns the pre-write value — confirmed live (registry.npmjs.org):
      // this exact check failed with "latest=2.115.3" right after a successful
      // `npm dist-tag add`, then a manual `npm view --dist-tags` moments later
      // already showed the new value. Retry the visibility read briefly
      // instead of treating one stale read as a real failure (and rolling
      // back a write that actually succeeded).
      let tags = {};
      let visible = false;
      for (let attempt = 0; attempt < 5 && !visible; attempt++) {
        if (attempt > 0) sleepSync(2000);
        tags = distTags(artifact.name, npmEnv);
        visible = tags[npmTag] === artifact.version;
      }
      if (!visible) throw new Error(`npm tag visibility mismatch: ${artifact.name}@${npmTag}=${tags[npmTag] ?? '<missing>'}`);
      moved.push(artifact.name);
    }
  } catch (error) {
    rollbackTags(moved, previous, npmTag, npmEnv);
    throw error;
  }

  if (flow === 'platform') promoteBinaryChannel(bundle, { repository, channel, candidateId, version });
  console.log(`::kb-output::${JSON.stringify({ candidateId, flow, version, channel, npmTag, promoted: true })}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function verifyBundle(bundleDir, expected) {
  const provenance = JSON.parse(readFileSync(join(bundleDir, 'provenance.json'), 'utf8'));
  for (const [key, value] of Object.entries(expected)) {
    if (provenance[key] !== value) throw new Error(`candidate ${key} mismatch: ${provenance[key]} != ${value}`);
  }
  for (const line of readFileSync(join(bundleDir, 'bundle.sha256'), 'utf8').trim().split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) throw new Error(`invalid bundle checksum line: ${line}`);
    const file = join(bundleDir, match[2]);
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (actual !== match[1]) throw new Error(`bundle checksum mismatch: ${match[2]}`);
  }
  const modePath = join(bundleDir, 'bundle.modes');
  if (!statSync(modePath).isFile()) throw new Error('candidate bundle has no executable-mode manifest');
  for (const line of readFileSync(modePath, 'utf8').trim().split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([0-7]{3,4})  (.+)$/);
    if (!match) throw new Error(`invalid bundle mode line: ${line}`);
    const actual = (statSync(join(bundleDir, match[2])).mode & 0o777).toString(8);
    const expected = match[1].replace(/^0/, '');
    if (actual !== expected) throw new Error(`bundle mode mismatch: ${match[2]}`);
  }
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
