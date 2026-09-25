/**
 * Release preflight (09 §3.1, roadmap R1.1): a seconds-fast environment check
 * that runs BEFORE the long checks stage. Read-only — it never starts Docker,
 * Verdaccio or anything else; it reports and gives the exact command to run.
 *
 * All I/O is injected (shell, fetch, env, baseline) so every failing condition
 * is unit-testable without touching the network. Secrets are only tested for
 * presence and are never read into messages.
 */

import type { ReleaseShell } from '../types';
import {
  createReleaseError,
  type ReleaseErrorCode,
  type ReleaseErrorEnvelope,
} from './error-codes';

export type PreflightCheckId =
  | 'branch'
  | 'clean-tree'
  | 'docker'
  | 'staging-registry'
  | 'npm-registry'
  | 'github-auth'
  | 'baseline-drift';

export interface PreflightCheckResult {
  id: PreflightCheckId;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  /** One-line human summary (what was observed). */
  message: string;
  /** Present when status is `failed`. */
  error?: ReleaseErrorEnvelope;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheckResult[];
  durationMs: number;
}

/** Minimal fetch surface, injectable in tests. */
export type PreflightFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

/** What the baseline-drift check needs; produced from `computeFlowReleaseStatus`. */
export interface PreflightBaseline {
  gitTag: string | null;
  gitVersion: string | null;
  npmStableVersion: string | null;
  npmStableDistTag: string;
  /** Sampled packages disagree on the stable dist-tag. */
  npmDrift: boolean;
  /** True when no sampled package could be resolved at all (registry problem, not drift). */
  npmUnresolved: boolean;
}

export interface PreflightOptions {
  cwd: string;
  shell: ReleaseShell;
  fetch: PreflightFetch;
  env: Record<string, string | undefined>;
  /** Branch releases must start from. Default `master`. */
  expectedBranch?: string;
  /** Explicit staging registry URL; otherwise derived from netOffset. */
  stagingRegistry?: string;
  netOffset?: number;
  /** Real npm registry to probe. Default https://registry.npmjs.org. */
  npmRegistry?: string;
  flow?: string;
  /** Lazily loads baseline info; omitted -> baseline check is skipped. */
  baseline?: () => Promise<PreflightBaseline>;
  /** Per-probe timeout, ms. Default 5000. */
  timeoutMs?: number;
}

const DEFAULT_VERDACCIO_PORT = 4873;
const PROBE_FAILURE_CODE: Record<PreflightCheckId, ReleaseErrorCode> = {
  branch: 'KB_RELEASE_BRANCH_NOT_MASTER',
  'clean-tree': 'KB_RELEASE_TREE_DIRTY',
  docker: 'KB_RELEASE_DOCKER_UNAVAILABLE',
  'staging-registry': 'KB_RELEASE_REGISTRY_UNREACHABLE',
  'npm-registry': 'KB_RELEASE_REGISTRY_UNREACHABLE',
  'github-auth': 'KB_RELEASE_TOKEN_MISSING',
  'baseline-drift': 'KB_RELEASE_BASELINE_DRIFT',
};
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

export function resolveStagingRegistry(opts: Pick<PreflightOptions, 'stagingRegistry' | 'netOffset' | 'env'>): string {
  const explicit = opts.stagingRegistry ?? opts.env.KB_RELEASE_STAGING_REGISTRY;
  if (explicit) { return explicit.replace(/\/$/, ''); }
  return `http://localhost:${DEFAULT_VERDACCIO_PORT + (opts.netOffset ?? 0)}`;
}

/**
 * Paths that never count as a dirty tree: candidate bundles are workflow
 * output (also listed in .gitignore; this covers a checkout where they show
 * up anyway, e.g. an older .gitignore).
 */
const IGNORED_DIRTY_PREFIXES = ['.kb/release/candidates/'];

function isIgnoredPath(path: string): boolean {
  const p = path.trim().replace(/^"|"$/g, '');
  return IGNORED_DIRTY_PREFIXES.some(prefix => p === prefix.slice(0, -1) || p.startsWith(prefix));
}

export function preflightCommand(flow?: string): string {
  return flow ? `pnpm kb release preflight --flow ${flow}` : 'pnpm kb release preflight';
}

type Outcome =
  | { ok: true; message: string }
  | { ok: false; message: string; code: ReleaseErrorCode; cause: string; hint: string; details?: Record<string, string> }
  | { skipped: true; message: string };

export async function runReleasePreflight(opts: PreflightOptions): Promise<PreflightResult> {
  const started = Date.now();
  const timeout = opts.timeoutMs ?? 5000;
  const expectedBranch = opts.expectedBranch ?? 'master';
  const staging = resolveStagingRegistry(opts);
  const npm = (opts.npmRegistry ?? DEFAULT_NPM_REGISTRY).replace(/\/$/, '');
  const rerun = preflightCommand(opts.flow);

  const ping = async (url: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
    try {
      const res = await opts.fetch(`${url}/-/ping`, { signal: AbortSignal.timeout(timeout) });
      return res.ok ? { ok: true } : { ok: false, reason: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };

  const specs: Array<[PreflightCheckId, () => Promise<Outcome>]> = [
    ['branch', async () => {
      const res = await opts.shell.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: opts.cwd, timeout });
      const branch = res.stdout.trim();
      if (!res.ok || !branch) {
        return { ok: false, message: 'Could not determine the current branch', code: 'KB_RELEASE_BRANCH_NOT_MASTER', cause: 'git rev-parse failed.', hint: `Run from inside the repository, then \`${rerun}\`.` };
      }
      if (branch !== expectedBranch) {
        return {
          ok: false, message: `On branch ${branch}`, code: 'KB_RELEASE_BRANCH_NOT_MASTER',
          cause: `Current branch is '${branch}', releases start from '${expectedBranch}'.`,
          hint: `Switch with \`git switch ${expectedBranch}\` and pull, then \`${rerun}\`.`,
          details: { branch, expected: expectedBranch },
        };
      }
      return { ok: true, message: `On ${branch}` };
    }],
    ['clean-tree', async () => {
      const res = await opts.shell.exec('git', ['status', '--porcelain'], { cwd: opts.cwd, timeout });
      if (!res.ok) {
        return { ok: false, message: 'Could not read git status', code: 'KB_RELEASE_TREE_DIRTY', cause: 'git status failed.', hint: `Run from inside the repository, then \`${rerun}\`.` };
      }
      const lines = res.stdout.split('\n').filter(l => l.trim() && !isIgnoredPath(l.slice(3)));
      if (lines.length > 0) {
        return {
          ok: false, message: `${lines.length} uncommitted change(s)`, code: 'KB_RELEASE_TREE_DIRTY',
          cause: `Working tree has ${lines.length} modified or untracked path(s), e.g. ${lines.slice(0, 3).map(l => l.slice(3)).join(', ')}.`,
          hint: `Commit, stash or discard them (\`git status\` lists them), then \`${rerun}\`.`,
          details: { changes: String(lines.length) },
        };
      }
      return { ok: true, message: 'Working tree clean' };
    }],
    ['docker', async () => {
      const res = await opts.shell.exec('docker', ['info', '--format', '{{.ServerVersion}}'], { cwd: opts.cwd, timeout });
      if (!res.ok) {
        return {
          ok: false, message: 'Docker daemon not reachable', code: 'KB_RELEASE_DOCKER_UNAVAILABLE',
          cause: '`docker info` failed: Docker is not installed or its daemon is not running.',
          hint: `Start Docker, then \`${rerun}\`.`,
        };
      }
      return { ok: true, message: `Docker ${res.stdout.trim() || 'available'}` };
    }],
    ['staging-registry', async () => {
      const r = await ping(staging);
      if (!r.ok) {
        const offset = opts.netOffset ?? 0;
        return {
          ok: false, message: `${staging} unreachable`, code: 'KB_RELEASE_REGISTRY_UNREACHABLE',
          cause: `Local staging registry ${staging} did not answer /-/ping (${r.reason}).`,
          hint: `Start it: \`./tools/kb-dev/kb-dev ensure verdaccio --config .kb/devservices.dev.yaml --net-offset ${offset}\`, then \`${rerun}\`.`,
          details: { target: 'staging', registry: staging },
        };
      }
      return { ok: true, message: `${staging} reachable` };
    }],
    ['npm-registry', async () => {
      const r = await ping(npm);
      if (!r.ok) {
        return {
          ok: false, message: `${npm} unreachable`, code: 'KB_RELEASE_REGISTRY_UNREACHABLE',
          cause: `npm registry ${npm} did not answer /-/ping (${r.reason}).`,
          hint: `Check network/proxy access to ${npm}, then \`${rerun}\`.`,
          details: { target: 'npm', registry: npm },
        };
      }
      return { ok: true, message: `${npm} reachable` };
    }],
    ['github-auth', async () => {
      const fromEnv = ['GH_TOKEN', 'GITHUB_TOKEN'].find(k => Boolean(opts.env[k]));
      if (fromEnv) { return { ok: true, message: `Token present via ${fromEnv}` }; }
      const res = await opts.shell.exec('gh', ['auth', 'status'], { cwd: opts.cwd, timeout });
      if (res.ok) { return { ok: true, message: 'gh is authenticated' }; }
      return {
        ok: false, message: 'No GitHub token or gh login', code: 'KB_RELEASE_TOKEN_MISSING',
        cause: 'Neither GH_TOKEN/GITHUB_TOKEN is set nor is `gh` authenticated; candidate dispatch needs one.',
        hint: `Run \`gh auth login\` (or export GH_TOKEN), then \`${rerun}\`.`,
      };
    }],
    ['baseline-drift', async (): Promise<Outcome> => {
      if (!opts.baseline) { return { skipped: true, message: 'Baseline source not provided' }; }
      let b: PreflightBaseline;
      try {
        b = await opts.baseline();
      } catch (err) {
        return { skipped: true, message: `Baseline could not be computed (${err instanceof Error ? err.message : String(err)})` };
      }
      if (b.npmUnresolved) {
        return { skipped: true, message: 'npm baseline unresolved (registry problem reported above)' };
      }
      const tag = b.npmStableDistTag;
      if (b.npmDrift) {
        return {
          ok: false, message: `Packages disagree on npm "${tag}"`, code: 'KB_RELEASE_BASELINE_DRIFT',
          cause: `Sampled packages resolve to different versions under npm "${tag}".`,
          hint: 'Inspect with `pnpm kb release status`; reconcile the dist-tags before releasing.',
          details: { distTag: tag },
        };
      }
      if (b.gitVersion && b.npmStableVersion && b.gitVersion !== b.npmStableVersion) {
        return {
          ok: false, message: `git ${b.gitVersion} vs npm ${b.npmStableVersion}`, code: 'KB_RELEASE_BASELINE_DRIFT',
          cause: `Latest stable git tag ${b.gitTag ?? ''} (${b.gitVersion}) does not match npm "${tag}" (${b.npmStableVersion}).`,
          hint: 'Inspect with `pnpm kb release status`; a half-finished release or manual publish left the baseline inconsistent.',
          details: { gitVersion: b.gitVersion, npmVersion: b.npmStableVersion },
        };
      }
      return { ok: true, message: b.gitVersion ? `git and npm agree on ${b.gitVersion}` : 'No stable tag yet; nothing to compare' };
    }],
  ];

  const checks = await Promise.all(specs.map(async ([id, run]): Promise<PreflightCheckResult> => {
    const t = Date.now();
    try {
      const out = await run();
      const durationMs = Date.now() - t;
      if ('skipped' in out) { return { id, status: 'skipped', durationMs, message: out.message }; }
      if (out.ok) { return { id, status: 'passed', durationMs, message: out.message }; }
      return {
        id, status: 'failed', durationMs, message: out.message,
        error: createReleaseError({
          code: out.code,
          cause: out.cause,
          hint: out.hint,
          details: { check: id, classification: 'environment', ...out.details },
          actions: [{ id: 'rerun-preflight', label: 'Re-run preflight', command: rerun }],
        }),
      };
    } catch (err) {
      return {
        id, status: 'failed', durationMs: Date.now() - t, message: 'Probe threw',
        error: createReleaseError({
          code: PROBE_FAILURE_CODE[id],
          cause: `Probe '${id}' threw: ${err instanceof Error ? err.message : String(err)}`,
          hint: `Re-run \`${rerun}\`; if it repeats, run the underlying tool by hand.`,
          details: { check: id, classification: 'environment' },
          actions: [{ id: 'rerun-preflight', label: 'Re-run preflight', command: rerun }],
        }),
      };
    }
  }));

  return { ok: checks.every(c => c.status !== 'failed'), checks, durationMs: Date.now() - started };
}
