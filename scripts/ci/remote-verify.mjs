#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteOperationError, runRemoteVerification } from './remote-verify-core.mjs';
import { parseArgs } from './remote-verify-options.mjs';
import { persistFailureEvidence } from './remote-verify-evidence.mjs';

const root = process.cwd();

function execute(command, args, { retryable = false, maxBuffer = 16 * 1024 * 1024 } = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer });
  if (result.error) throw new RemoteOperationError(`${command} could not run`, { retryable, cause: result.error });
  if (result.status !== 0) {
    const diagnostic = (result.stderr || result.stdout || `${command} exited with status ${result.status}`).trim().slice(-2000);
    throw new RemoteOperationError(`${command} operation failed: ${diagnostic}`, { retryable });
  }
  return result.stdout.trim();
}

function createExecutors(scratch) {
  const git = {
    headSha: async () => execute('git', ['rev-parse', 'HEAD']),
    currentBranch: async () => execute('git', ['branch', '--show-current']),
    backupRemote: async () => execute('git', ['remote', 'get-url', 'backup']),
    pushRef: async (ref, sha) => execute('git', ['push', 'backup', `${sha}:refs/heads/${ref}`], { retryable: true }),
    resolveRef: async (remote, ref) => {
      const output = execute('git', ['ls-remote', remote, `refs/heads/${ref}`], { retryable: true });
      const [resolvedSha] = output.split(/\s+/);
      if (!resolvedSha) throw new RemoteOperationError(`Verification ref ${ref} does not exist on backup`, { retryable: true });
      return resolvedSha;
    },
    deleteRef: async (remote, ref) => execute('git', ['push', remote, `:refs/heads/${ref}`], { retryable: true }),
  };

  const gh = {
    listRuns: async (repo, branch, event) => JSON.parse(execute('gh', ['api', `repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&event=${event}&per_page=100`], { retryable: true } )).workflow_runs ?? [],
    dispatchRun: async (repo, ref, profile, baseRef) => execute('gh', ['workflow', 'run', 'remote-verify.yml', '--repo', repo, '--ref', ref, '-f', `profile=${profile}`, ...(baseRef ? ['-f', `base_ref=${baseRef}`] : [])], { retryable: true }),
    getRun: async (repo, runId) => JSON.parse(execute('gh', ['api', `repos/${repo}/actions/runs/${runId}`], { retryable: true })),
    downloadVerdict: async (repo, runId) => {
      const dir = path.join(scratch, String(runId));
      mkdirSync(dir, { recursive: true });
      execute('gh', ['run', 'download', String(runId), '--repo', repo, '--name', 'remote-verdict', '--dir', dir], { retryable: true });
      return JSON.parse(readFileSync(path.join(dir, 'verdict.json'), 'utf8'));
    },
    failureJobs: async (repo, runId) => JSON.parse(execute('gh', ['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`], { retryable: true })),
    failureLogs: async (repo, runId, jobId) => execute('gh', ['run', 'view', String(runId), '--repo', repo, '--job', String(jobId), '--log-failed'], { retryable: true, maxBuffer: 4 * 1024 * 1024 }),
    failureArtifacts: async (repo, runId) => {
      const dir = path.join(scratch, `${runId}-failed-artifacts`);
      mkdirSync(dir, { recursive: true });
      execute('gh', ['run', 'download', String(runId), '--repo', repo, '--dir', dir], { retryable: true, maxBuffer: 4 * 1024 * 1024 });
      const jsonFiles = [];
      const collect = (directory) => {
        for (const entry of readdirSync(directory)) {
          const file = path.join(directory, entry);
          if (statSync(file).isDirectory()) collect(file);
          else if (entry.endsWith('.json')) jsonFiles.push({ name: path.relative(dir, file), content: readFileSync(file, 'utf8') });
        }
      };
      collect(dir);
      return jsonFiles;
    },
  };
  return { git, gh };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2), root);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const outDir = path.dirname(options.out);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'kb-remote-verify-'));
  try {
    let verdict = await runRemoteVerification(options, createExecutors(scratch));
    const failureEvidence = verdict.failureEvidence ?? { jobs: [], structuredArtifacts: [] };
    verdict = persistFailureEvidence(options.out, verdict, failureEvidence.jobs, failureEvidence.structuredArtifacts);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(verdict, null, 2)}\n`);
    process.stdout.write(`Remote verification ${verdict.status} for ${verdict.sha}; verdict: ${options.out}\n`);
    return verdict.status === 'pass' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Remote verification could not write ${options.out}: ${error.message}\n`);
    return 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

process.exitCode = await main();
