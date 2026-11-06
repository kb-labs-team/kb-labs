/**
 * Programmatic npm publishing for REST handlers (non-interactive context).
 *
 * Uses the package manager's CLI via argv; npm resolves registry credentials
 * from its protected user configuration when no explicit token is supplied.
 * This is the correct approach for granular access tokens (classic tokens
 * were revoked by npm in December 2025).
 *
 * Token resolution order:
 * 1. options.token (explicit override)
 * 2. NPM_TOKEN env variable
 * 3. NODE_AUTH_TOKEN env variable
 * 4. npm's user configuration
 *
 * Reliability guarantees:
 * - Already-published versions are treated as success (idempotent re-runs).
 * - 429 rate-limit: exponential back-off with jitter, up to MAX_RETRIES attempts.
 * - Transient network errors (ECONNRESET, ETIMEDOUT, etc.) are also retried.
 * - Packages are published in topological order (deps before dependants).
 * - Default concurrency is 4 — enough throughput, low enough to avoid rate limits.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { useLogger, useEnv } from '@kb-labs/sdk';
import { rewriteWorkspaceDeps, topoSort } from './dep-rewrite';

export interface PackageToPublish {
  name: string;
  version: string;
  path: string;
  /**
   * Pre-built tarball to publish instead of packing fresh from `path`
   * (produced by `release artifact create` — see stage.ts). When set, `path` is
   * used as the process working directory — no
   * `rewriteWorkspaceDeps` mutation happens, since the tarball's
   * package.json is already final and must ship byte-for-byte unchanged.
   */
  tarballPath?: string;
}

export interface ProgrammaticPublishOptions {
  packages: PackageToPublish[];
  packageManager?: 'pnpm' | 'npm' | 'yarn';
  dryRun?: boolean;
  otp?: string;
  tag?: string;
  access?: 'public' | 'restricted';
  registry?: string;
  token?: string;
}

export interface PublishResult {
  name: string;
  version: string;
  success: boolean;
  /** Package was already published at this version — counted as success. */
  alreadyPublished?: boolean;
  error?: string;
  /** npm's own error code (e.g. "E403"), extracted from its stderr, when recognizable. */
  errorCode?: string;
  /** Actionable, human-readable explanation for errorCode — see NPM_ERROR_HINTS. */
  errorHint?: string;
}

export interface ProgrammaticPublishResult {
  results: PublishResult[];
  published: string[];
  /** Versions that were already on npm (counted as success). */
  alreadyPublished: string[];
  failed: string[];
  skipped: string[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

const MAX_RETRIES = 5;

// Exponential base delays (ms). Actual delay = base * jitter(0.8–1.2).
const RETRY_BASE_DELAYS_MS = [10_000, 20_000, 40_000, 80_000, 160_000] as const;

/** Retryable error patterns — all transient, not indicative of a bad package. */
const RETRYABLE_PATTERNS = [
  'E429',
  '429 Too Many Requests',
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'socket hang up',
  'network timeout',
  'read ECONNRESET',
];

/** "Already published" — treat as success so re-runs are idempotent. */
const ALREADY_PUBLISHED_PATTERNS = [
  'You cannot publish over the previously published versions',
  'cannot publish over the previously published version',
  'EPUBLISHCONFLICT',
  // Some registries return 403 for conflicts
  // Verdaccio (the local staging registry `release:stage-plan` publishes
  // to — see stage-plan.ts) returns this instead of npmjs.org's wording for
  // the identical condition: a version this exact commit already staged in
  // an earlier, since-failed release-prepare run (e.g. an unrelated later
  // step failed, or the workflow daemon ran out of workers). Without this,
  // every retry at the same commit fails Stage permanently — Verdaccio's
  // per-version storage is immutable, so nothing short of wiping its volume
  // would ever let a retry get past it.
  'this package is already present',
];

function isRetryable(message: string): boolean {
  return RETRYABLE_PATTERNS.some(p => message.includes(p));
}

function isAlreadyPublished(message: string): boolean {
  if (ALREADY_PUBLISHED_PATTERNS.some(p => message.includes(p))) { return true; }
  return extractNpmErrorCode(message) === 'E409';
}

/**
 * Human-readable hints per npm error code — surfaced directly in the
 * delivery report so a permanent failure doesn't require digging through
 * raw CI logs to tell "our token is broken" apart from "npm has flagged
 * this specific package," which look identical (both E403) but need
 * completely different fixes.
 */
const NPM_ERROR_HINTS: Record<string, string> = {
  E403: 'npm rejected the publish (403). If other packages in the same run succeeded with the same token, this is almost certainly an npm-side restriction on this specific package/account entry (e.g. a security hold), not a token or code problem — check npmjs.com directly or contact npm support. Retrying will not help until that is resolved.',
  E401: 'Registry authentication failed (401) — configure npm credentials for this registry with `npm adduser --registry <url> --auth-type=legacy`, or provide NPM_TOKEN/NODE_AUTH_TOKEN.',
  E404: 'Registry returned 404 — check the registry URL and that the package name/scope is correct and accessible with this token.',
  EOTP: 'npm requires a one-time password for this publish — programmatic (token-based) delivery cannot supply one; this package needs an interactive `npm publish` from a human, or a token exempt from OTP.',
};

/** Extract the npm CLI's own error code (e.g. "E403") from its stderr, if present. */
function extractNpmErrorCode(message: string): string | undefined {
  const match = message.match(/\bnpm error code (E[A-Z0-9]+)\b/);
  return match?.[1];
}

/** Classify a permanent publish failure into a code + actionable hint, when recognizable. */
function classifyPublishError(message: string): { code?: string; hint?: string } {
  const code = extractNpmErrorCode(message);
  const hint = code ? NPM_ERROR_HINTS[code] : undefined;
  return { code, hint };
}

/** Exponential back-off with ±20% jitter. */
function retryDelay(attempt: number): number {
  const base = RETRY_BASE_DELAYS_MS[Math.min(attempt, RETRY_BASE_DELAYS_MS.length - 1)]!;
  const jitter = 0.8 + Math.random() * 0.4; // 0.8 – 1.2
  return Math.round(base * jitter);
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

function resolveToken(token?: string): string | undefined {
  return token ?? useEnv('NPM_TOKEN') ?? useEnv('NODE_AUTH_TOKEN');
}

// ---------------------------------------------------------------------------
// Low-level spawn
// ---------------------------------------------------------------------------

/**
 * Spawn `packageManager publish` for a single package without shell parsing.
 * Explicit tokens are scoped to the registry in the child process environment.
 */
function spawnPublish(options: {
  packagePath: string;
  /** Publish this exact tarball instead of packing `packagePath` fresh. */
  tarballPath?: string;
  packageManager: string;
  token: string | undefined;
  otp?: string;
  dryRun?: boolean;
  tag?: string;
  access?: string;
  registry?: string;
}): Promise<void> {
  const { packagePath, tarballPath, packageManager, token, otp, dryRun, tag, access, registry } = options;

  return new Promise((resolve, reject) => {
    const args = ['publish', '--no-update-notifier'];
    if (tarballPath) { args.push(tarballPath); }

    if (packageManager === 'pnpm' && !tarballPath) {
      // pnpm checks git cleanliness; we version-bump before publish which makes
      // the tree dirty — bypass that check. N/A when publishing a pre-built
      // tarball — there's no working-tree state for pnpm to check.
      args.push('--no-git-checks');
    }
    if (tarballPath) { args.push('--ignore-scripts'); }
    if (dryRun)   { args.push('--dry-run', '--offline'); }
    if (tag)      { args.push(`--tag=${tag}`); }
    if (access)   { args.push(`--access=${access}`); }
    if (registry) { args.push(`--registry=${registry}`); }
    if (otp)      { args.push(`--otp=${otp}`); }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (token) { env['NODE_AUTH_TOKEN'] = token; }
    const isolatedDir = dryRun ? mkdtempSync(join(tmpdir(), 'kb-publish-dry-run-')) : undefined;
    if (isolatedDir) {
      env.HOME = isolatedDir;
      env.npm_config_cache = join(isolatedDir, 'cache');
      env.npm_config_userconfig = join(isolatedDir, 'npmrc');
      delete env.NPM_CONFIG_USERCONFIG;
      delete env.NPM_TOKEN;
      delete env.NODE_AUTH_TOKEN;
      for (const key of Object.keys(env)) {
        if (/^npm_config_\/\/.*:_(?:authToken|auth|password)$/i.test(key)) delete env[key];
      }
    } else if (token) {
      // npm_config_//host/:_authToken is a scoped npm configuration key.
      // Environment configuration overrides both project and user npmrc files.
      const registryHost = registry ? new URL(registry).host : 'registry.npmjs.org';
      delete env[`NPM_CONFIG_//${registryHost}/:_authToken`];
      env[`npm_config_//${registryHost}/:_authToken`] = token;
    }

    const cleanup = () => {
      if (isolatedDir) { rmSync(isolatedDir, { recursive: true, force: true }); }
    };

    const child = spawn(packageManager, args, {
      cwd: packagePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code: number | null) => {
      cleanup();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || stdout || `${packageManager} publish exited with code ${code}`));
      }
    });

    child.on('error', (err: Error) => {
      cleanup();
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Per-package publish with retry
// ---------------------------------------------------------------------------

async function publishOne(
  pkg: PackageToPublish,
  opts: {
    packageManager: string;
    token: string | undefined;
    versionMap: Map<string, string>;
    dryRun?: boolean;
    otp?: string;
    tag?: string;
    access?: string;
    registry?: string;
  },
  logger: ReturnType<typeof useLogger>,
): Promise<PublishResult> {
  // A pre-built tarball (see PackageToPublish.tarballPath) is already final
  // — publishing it must ship those exact bytes, so skip the package.json
  // rewrite entirely rather than mutating a directory whose content the
  // tarball no longer reflects.
  const restore = pkg.tarballPath ? (() => {}) : rewriteWorkspaceDeps(pkg, opts.versionMap, opts.packageManager);

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await spawnPublish({
          packagePath: pkg.path,
          tarballPath: pkg.tarballPath,
          packageManager: opts.packageManager,
          token: opts.token,
          otp: opts.otp,
          dryRun: opts.dryRun,
          tag: opts.tag,
          access: opts.access,
          registry: opts.registry,
        });

        logger.info(`Published ${pkg.name}@${pkg.version}`);
        return { name: pkg.name, version: pkg.version, success: true };

      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        // Idempotency: already published at this version → success.
        if (isAlreadyPublished(message)) {
          logger.info(`${pkg.name}@${pkg.version} already published — skipping`);
          return { name: pkg.name, version: pkg.version, success: true, alreadyPublished: true };
        }

        // Retryable transient error (rate-limit, network blip).
        if (!opts.dryRun && isRetryable(message) && attempt < MAX_RETRIES) {
          const delay = retryDelay(attempt);
          logger.warn(
            `Transient error for ${pkg.name}@${pkg.version} (attempt ${attempt + 1}/${MAX_RETRIES}), ` +
            `retrying in ${(delay / 1000).toFixed(1)}s: ${message.split('\n')[0]}`,
          );
          await new Promise<void>(r => { setTimeout(r, delay); });
          continue;
        }

        // Permanent failure.
        const { code, hint } = classifyPublishError(message);
        logger.error(`Failed to publish ${pkg.name}@${pkg.version}`, undefined, { error: message, errorCode: code });
        return { name: pkg.name, version: pkg.version, success: false, error: message, errorCode: code, errorHint: hint };
      }
    }

    // Exhausted retries.
    return {
      name: pkg.name,
      version: pkg.version,
      success: false,
      error: `Publish failed after ${MAX_RETRIES} retries (transient errors)`,
    };
  } finally {
    restore();
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

function skipRemainingWaves(
  waves: ReturnType<typeof topoSort>,
  waveIdx: number,
  waveFailed: PublishResult[],
  logger: ReturnType<typeof useLogger>,
  allResults: PublishResult[],
): void {
  const remaining = waves.slice(waveIdx + 1).reduce((acc, w) => acc + w.length, 0);
  if (remaining === 0) { return; }
  logger.warn(
    `Wave ${waveIdx + 1} had ${waveFailed.length} failure(s) — ` +
    `skipping ${remaining} package(s) in later waves to avoid broken dependency chain`,
  );
  for (const laterWave of waves.slice(waveIdx + 1)) {
    for (const pkg of laterWave) {
      allResults.push({ name: pkg.name, version: pkg.version, success: false, error: 'Skipped: dependency wave failed' });
    }
  }
}

/**
 * Publish packages programmatically (non-interactive, for REST handlers / CI).
 *
 * Packages are published in topological order (deps before dependants) to
 * avoid "package not found" errors when a dependent is installed right after
 * release. Within each topological wave, publishes run in parallel up to
 * CONCURRENCY.
 */
export async function publishPackagesProgrammatic(
  options: ProgrammaticPublishOptions,
): Promise<ProgrammaticPublishResult> {
  const {
    packages,
    packageManager = 'pnpm',
    dryRun,
    otp,
    tag,
    access,
    registry,
  } = options;

  const logger = useLogger();
  const token = resolveToken(options.token);

  // Version map for dep rewriting (workspace:/link: → ^version).
  const versionMap = new Map(packages.map(p => [p.name, p.version]));

  // Concurrency: default 4 — enough throughput, below npm's sustained rate limit.
  const CONCURRENCY = Number(useEnv('KB_PUBLISH_CONCURRENCY') ?? 4);

  // Sort packages into topological waves so deps are always published first.
  const waves = topoSort(packages, packageManager);

  logger.info(
    `Publishing ${packages.length} package(s) in ${waves.length} topological wave(s) ` +
    `(concurrency=${CONCURRENCY}, dryRun=${dryRun ?? false})`,
  );

  const allResults: PublishResult[] = [];

  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    const wave = waves[waveIdx]!;
    logger.info(`Wave ${waveIdx + 1}/${waves.length}: publishing ${wave.length} package(s)`);

    // Publish wave in parallel batches.
    for (let i = 0; i < wave.length; i += CONCURRENCY) {
      const batch = wave.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(pkg =>
          publishOne(pkg, { packageManager, token, versionMap, dryRun, otp, tag, access, registry }, logger),
        ),
      );
      allResults.push(...batchResults);
    }

    // If any package in this wave genuinely failed (not alreadyPublished), stop
    // publishing the next wave — it may depend on the failed packages.
    const waveFailed = allResults.slice(-wave.length).filter(r => !r.success);
    if (waveFailed.length > 0) {
      skipRemainingWaves(waves, waveIdx, waveFailed, logger, allResults);
      break;
    }
  }

  const published         = allResults.filter(r => r.success && !r.alreadyPublished).map(r => `${r.name}@${r.version}`);
  const alreadyPublished  = allResults.filter(r => r.alreadyPublished).map(r => `${r.name}@${r.version}`);
  const failed            = allResults.filter(r => !r.success).map(r => `${r.name}@${r.version}`);
  const errors            = allResults.filter(r => !r.success && r.error).map(r => `${r.name}: ${r.error}`);

  if (alreadyPublished.length > 0) {
    logger.info(`${alreadyPublished.length} package(s) already published — counted as success`);
  }

  return {
    results: allResults,
    published,
    alreadyPublished,
    failed,
    skipped: dryRun ? packages.map(p => `${p.name}@${p.version} (dry-run)`) : [],
    errors,
  };
}
