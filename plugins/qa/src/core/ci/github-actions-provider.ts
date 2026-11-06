import type { ShellAPI } from '@kb-labs/sdk';
import type { CiEvidenceSyncResult, CiFailureEvidence, CiJobEvidence, CiRunDossier, CiStepEvidence } from '../../contracts/index.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

interface GithubRun {
  id: number;
  run_attempt: number;
  event: string;
  status: string;
  conclusion: string | null;
  run_started_at: string | null;
  updated_at: string | null;
  head_sha: string;
  head_branch: string | null;
  html_url: string;
  name: string;
  path?: string;
}

interface GithubJob {
  id: number;
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
  runner_name?: string;
  runner_group_name?: string;
  steps?: Array<{ number: number; name: string; conclusion: string | null; started_at: string | null; completed_at: string | null }>;
}

interface GithubJobsResponse { jobs: GithubJob[]; }
type GithubStep = NonNullable<GithubJob['steps']>[number];
interface GithubRunListEntry { databaseId: number; }

export interface CiProvider {
  captureRun(input: {
    repository: string;
    runId: string;
    workflowPath?: string;
    workflowSha?: string;
    excludeJobNames?: string[];
  }): Promise<CiRunDossier>;
}

/** GitHub Actions adapter. The only external requirement is the GitHub CLI already present on Actions runners. */
export class GithubActionsProvider implements CiProvider {
  constructor(private readonly shell: ShellAPI, private readonly cwd: string) {}

  async captureRun(input: {
    repository: string;
    runId: string;
    workflowPath?: string;
    workflowSha?: string;
    excludeJobNames?: string[];
  }): Promise<CiRunDossier> {
    const run = await this.api<GithubRun>(`repos/${input.repository}/actions/runs/${input.runId}`);
    const jobsResponse = await this.api<GithubJobsResponse>(`repos/${input.repository}/actions/runs/${input.runId}/jobs?per_page=100`);
    const failedLog = await this.getFailedLog(input.repository, input.runId);
    const excludedJobs = new Set(input.excludeJobNames ?? []);
    const jobs = jobsResponse.jobs
      .filter(job => !excludedJobs.has(job.name))
      .map(job => this.toEvidence(job, failedLog));
    const complete = jobs.length > 0 && jobs.every(job => job.conclusion !== null);
    return {
      schemaVersion: 1,
      provider: 'github-actions',
      collectedAt: new Date().toISOString(),
      collectionStatus: complete ? 'complete' : 'partial',
      run: {
        id: String(run.id), attempt: run.run_attempt, event: run.event, status: run.status,
        conclusion: run.conclusion, startedAt: run.run_started_at, completedAt: run.updated_at,
        headSha: run.head_sha, headBranch: run.head_branch, htmlUrl: run.html_url,
      },
      workflow: { name: run.name, path: input.workflowPath, sha: input.workflowSha },
      jobs,
      sourceRefs: [
        { kind: 'run', url: run.html_url, label: `GitHub Actions run ${run.id}` },
        ...jobs.map(job => ({ kind: 'job-log' as const, url: job.htmlUrl, label: job.name })),
      ],
    };
  }

  /** Downloads immutable run artifacts only when this workspace has not seen them yet. */
  async syncDossiers(input: { repository: string; workflow: string; limit: number; outputDir: string }): Promise<CiEvidenceSyncResult> {
    const list = await this.shell.exec('gh', [
      'run', 'list', '--repo', input.repository, '--workflow', input.workflow,
      '--limit', String(input.limit), '--json', 'databaseId',
    ], { cwd: this.cwd, throwOnError: false });
    if (!list.ok) {
      throw new Error(`Unable to list GitHub Actions runs: ${list.stderr.trim() || list.stdout.trim()}`);
    }
    const runs = JSON.parse(list.stdout) as GithubRunListEntry[];
    const result: CiEvidenceSyncResult = { requestedRuns: runs.length, downloadedRunIds: [], cachedRunIds: [], unavailableRunIds: [] };
    for (const run of runs) {
      const runId = String(run.databaseId);
      const target = join(input.outputDir, runId, 'dossier.json');
      if (existsSync(target)) {
        result.cachedRunIds.push(runId);
        continue;
      }
      const download = await this.shell.exec('gh', [
        'run', 'download', runId, '--repo', input.repository,
        '--name', `qa-ci-evidence-${runId}`, '--dir', join(input.outputDir, runId),
      ], { cwd: this.cwd, throwOnError: false });
      if (download.ok && existsSync(target)) {result.downloadedRunIds.push(runId);}
      else {result.unavailableRunIds.push(runId);}
    }
    return result;
  }

  private async api<T>(path: string): Promise<T> {
    const result = await this.shell.exec('gh', ['api', `/${path}`], { cwd: this.cwd, throwOnError: false });
    if (!result.ok) {
      throw new Error(`GitHub Actions API request failed for ${path}: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return JSON.parse(result.stdout) as T;
  }

  private async getFailedLog(repository: string, runId: string): Promise<string | undefined> {
    const result = await this.shell.exec('gh', ['run', 'view', runId, '--repo', repository, '--log-failed'], {
      cwd: this.cwd, throwOnError: false,
    });
    return result.ok && result.stdout.trim() ? result.stdout : undefined;
  }

  private toEvidence(job: GithubJob, failedLog?: string): CiJobEvidence {
    const steps = (job.steps ?? []).map(step => this.toStep(step));
    const failedStep = steps.find(step => step.conclusion === 'failure');
    return {
      id: String(job.id), name: job.name, conclusion: job.conclusion,
      startedAt: job.started_at, completedAt: job.completed_at,
      durationMs: duration(job.started_at, job.completed_at), htmlUrl: job.html_url,
      runner: { name: job.runner_name, group: job.runner_group_name },
      steps,
      failure: failedStep ? classifyFailure(failedStep.name, failedLog) : undefined,
    };
  }

  private toStep(step: GithubStep): CiStepEvidence {
    return {
      number: step.number, name: step.name, conclusion: step.conclusion,
      startedAt: step.started_at, completedAt: step.completed_at,
      durationMs: duration(step.started_at, step.completed_at),
    };
  }
}

function duration(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) {return null;}
  const value = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function classifyFailure(stepName: string, failedLog?: string): CiFailureEvidence {
  const normalized = stepName.toLowerCase();
  const log = failedLog?.toLowerCase() ?? '';
  if (log.includes('registry-1.docker.io') || log.includes('docker hub') || log.includes('client.timeout exceeded')) {
    return {
      phase: 'setup', fingerprint: 'network.registry.docker-hub-timeout',
      summary: 'Container registry request timed out before tests started',
      excerpt: excerpt(failedLog, /registry-1\.docker\.io|Client\.Timeout exceeded|docker hub/i), confidence: 0.95,
    };
  }
  if (log.includes('permission_denied') || log.includes('denied:')) {
    return {
      phase: 'publish', fingerprint: 'permissions.registry.denied', summary: 'Container registry permission was denied',
      excerpt: excerpt(failedLog, /permission_denied|denied:/i), confidence: 0.9,
    };
  }
  if (log.includes('e403') || log.includes('forbidden')) {
    return {
      phase: 'publish', fingerprint: 'permissions.package-publish-forbidden', summary: 'Package publish was forbidden',
      excerpt: excerpt(failedLog, /E403|forbidden/i), confidence: 0.9,
    };
  }
  if (normalized.includes('test') || normalized.includes('playwright')) {
    return { phase: 'test', fingerprint: 'test.failure.unclassified', summary: `Test step failed: ${stepName}`, confidence: 0.45 };
  }
  if (normalized.includes('build') || normalized.includes('pack')) {
    return { phase: 'build', fingerprint: 'build.failure.unclassified', summary: `Build step failed: ${stepName}`, confidence: 0.45 };
  }
  if (normalized.includes('publish') || normalized.includes('deploy')) {
    return { phase: 'publish', fingerprint: 'publish.failure.unclassified', summary: `Publish step failed: ${stepName}`, confidence: 0.45 };
  }
  return { phase: 'setup', fingerprint: 'setup.failure.unclassified', summary: `Setup step failed: ${stepName}`, confidence: 0.35 };
}

function excerpt(log: string | undefined, pattern: RegExp): string | undefined {
  if (!log) {return undefined;}
  const line = log.split('\n').find(value => pattern.test(value));
  return line?.trim().slice(0, 500);
}
