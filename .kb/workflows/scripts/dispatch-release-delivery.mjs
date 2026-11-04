#!/usr/bin/env node

// Dispatch delivery for a previously built candidate. The caller supplies the
// trusted identity and digest recorded outside the downloaded bundle.
import { execFileSync } from 'node:child_process';

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
const target = required('--target');
const commit = required('--commit');
const expectedDigest = required('--expected-digest');
const workflow = value('--workflow') ?? 'release-deliver-candidate.yml';
const repository = value('--repository') ?? process.env.GITHUB_REPOSITORY;
const timeoutMs = Number(value('--timeout-ms') ?? 3_600_000);
if (!repository) throw new Error('--repository or GITHUB_REPOSITORY is required');

const run = (command, commandArgs) => execFileSync(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const startedAt = Date.now();
run('gh', ['workflow', 'run', workflow, '--repo', repository, '--ref', 'master', '-f', `candidate_run_id=${candidateRunId}`, '-f', `candidate_id=${candidateId}`, '-f', `flow=${flow}`, '-f', `version=${version}`, '-f', `channel=${target}`, '-f', `commit_sha=${commit}`, '-f', `expected_digest=${expectedDigest}`]);

let runId;
while (!runId && Date.now() - startedAt < timeoutMs) {
  const runs = JSON.parse(run('gh', ['run', 'list', '--repo', repository, '--workflow', workflow, '--limit', '20', '--json', 'databaseId,headSha,status,createdAt,event']));
  const candidate = runs.find(item => item.event === 'workflow_dispatch' && Date.parse(item.createdAt) >= startedAt - 5_000);
  if (candidate) runId = String(candidate.databaseId);
  if (!runId) execFileSync('sleep', ['5']);
}
if (!runId) throw new Error(`delivery workflow was not observed within ${timeoutMs}ms`);

let result;
while (Date.now() - startedAt < timeoutMs) {
  result = JSON.parse(run('gh', ['run', 'view', runId, '--repo', repository, '--json', 'status,conclusion']));
  if (result.status === 'completed') break;
  execFileSync('sleep', ['10']);
}
if (!result || result.status !== 'completed' || result.conclusion !== 'success') {
  throw new Error(`delivery workflow ${runId} did not succeed: ${JSON.stringify(result)}`);
}
console.log(`::kb-output::${JSON.stringify({ candidateId, candidateRunId, deliveryRunId: runId, target, commit, expectedDigest })}`);
