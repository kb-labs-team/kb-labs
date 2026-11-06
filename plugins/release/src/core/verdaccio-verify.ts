/**
 * Registry-side artifact verification — confirms a package actually landed
 * on a registry (Verdaccio) with the expected content, before it's promoted
 * to npm `latest`.
 *
 * Deliberately separate from verifier.ts: that module is pure local
 * validation (npm pack from the working tree, no registry I/O) so it stays
 * usable offline/in restricted CI. This module does registry round-trips —
 * it's the "did the publish actually work, and is what landed still sane"
 * check that only makes sense to run *after* a publish.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { isVersionPublished } from './planner';
import { verifyExtractedTarball } from './verifier';
import type { PublishablePackage, VerifyResult, PluginLogger } from './types';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Backoff schedule for the "is it published yet" poll only — tuned for
 * registry propagation lag (seconds), not for npm rate-limiting (which
 * `publish-programmatic.ts` already handles separately, on a much longer
 * schedule, around the publish call itself). Verdaccio (this module's
 * original caller) is synchronous, so `retries: 0` keeps that path's
 * behavior exactly as before; real npm has observable lag, so `deliver`
 * passes a non-zero `retries`.
 */
const DEFAULT_POLL_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;

export interface VerifyAgainstRegistryOptions {
  registry: string;
  /** Timeout (ms) for the registry HTTP check and the `npm pack` round-trip. Default: 30000. */
  timeout?: number;
  /**
   * Extra attempts for the "is it published yet" check before giving up —
   * each retry waits `retryDelaysMs[attempt]` (capped at the last entry).
   * Default: 0 (single attempt, matches pre-existing Verdaccio behavior).
   */
  retries?: number;
  /**
   * Total time to wait for npm metadata and tarballs to propagate after a
   * publish. When provided this supersedes the legacy fixed retry count, so
   * an idempotent re-run resumes verification of already-published tarballs
   * instead of requiring a new publish or a workflow-owned sleep.
   */
  visibilityDeadlineMs?: number;
  retryDelaysMs?: readonly number[];
  logger?: Pick<PluginLogger, 'info' | 'warn'>;
}

/**
 * Verify that each package landed on `registry` at its expected version,
 * and that the tarball actually published there passes the same static
 * checks verifyPackage() runs pre-publish (catches publish-time corruption
 * distinct from pre-publish source issues).
 */
export async function verifyAgainstRegistry(
  packages: PublishablePackage[],
  options: VerifyAgainstRegistryOptions,
): Promise<VerifyResult[]> {
  const { registry, timeout = DEFAULT_TIMEOUT_MS, retries = 0, retryDelaysMs = DEFAULT_POLL_RETRY_DELAYS_MS, logger } = options;
  const results: VerifyResult[] = [];

  for (const pkg of packages) {
    results.push(await verifyOneAgainstRegistry(pkg, registry, timeout, retries, retryDelaysMs, options.visibilityDeadlineMs, logger));
  }

  return results;
}

async function waitUntilPublished(
  pkg: PublishablePackage,
  registry: string,
  retries: number,
  retryDelaysMs: readonly number[],
  visibilityDeadlineMs: number | undefined,
  logger?: Pick<PluginLogger, 'info' | 'warn'>,
): Promise<boolean> {
  const deadline = visibilityDeadlineMs === undefined ? undefined : Date.now() + visibilityDeadlineMs;
  for (let attempt = 0; deadline === undefined ? attempt <= retries : Date.now() <= deadline; attempt++) {
    if (await isVersionPublished(pkg.name, pkg.version, registry)) {
      return true;
    }
    if (deadline === undefined ? attempt < retries : Date.now() < deadline) {
      const delay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]!;
      const remaining = deadline === undefined ? undefined : deadline - Date.now();
      const waitMs = remaining === undefined ? delay : Math.min(delay, Math.max(0, remaining));
      logger?.warn?.(
        `${pkg.name}@${pkg.version} not yet visible on ${registry} (attempt ${attempt + 1}${deadline === undefined ? `/${retries + 1}` : ''}), ` +
        `retrying in ${(waitMs / 1000).toFixed(0)}s${remaining === undefined ? '' : `; ${(Math.max(0, remaining) / 1000).toFixed(0)}s remain`} — likely registry propagation lag`,
      );
      await new Promise<void>(r => { setTimeout(r, waitMs); });
    }
  }
  return false;
}

async function verifyOneAgainstRegistry(
  pkg: PublishablePackage,
  registry: string,
  timeout: number,
  retries: number,
  retryDelaysMs: readonly number[],
  visibilityDeadlineMs: number | undefined,
  logger?: Pick<PluginLogger, 'info' | 'warn'>,
): Promise<VerifyResult> {
  const published = await waitUntilPublished(pkg, registry, retries, retryDelaysMs, visibilityDeadlineMs, logger);
  if (!published) {
    const waited = visibilityDeadlineMs === undefined
      ? `waited through ${retries} retr${retries === 1 ? 'y' : 'ies'}`
      : `visibility deadline of ${(visibilityDeadlineMs / 1000).toFixed(0)}s elapsed`;
    return { name: pkg.name, success: false, issues: [`${pkg.name}@${pkg.version} was not found on ${registry} after publish (${waited})`] };
  }
  logger?.info?.(`${pkg.name}@${pkg.version} confirmed on ${registry}`);

  const tmpDir = join(tmpdir(), `kb-verdaccio-verify-${randomBytes(6).toString('hex')}`);
  const issues: string[] = [];

  try {
    mkdirSync(tmpDir, { recursive: true });

    // Metadata visibility (waitUntilPublished, via `npm view`) and tarball
    // fetchability (`npm pack`, below) are backed by different layers of
    // npm's infrastructure — the manifest API and the tarball CDN — with
    // independent propagation lag. A package can be `npm view`-visible
    // (waitUntilPublished already succeeded above) while `npm pack` still
    // 404s for a few more seconds. Reuse the same retry budget here instead
    // of treating the first ETARGET as final.
    const spec = `${pkg.name}@${pkg.version}`;
    let packResult = spawnSync(
      'npm',
      ['pack', spec, '--registry', registry, '--pack-destination', tmpDir],
      { stdio: 'pipe', timeout },
    );

    for (let attempt = 0; packResult.status !== 0 && attempt < retries; attempt++) {
      const delay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]!;
      logger?.warn?.(
        `${spec} is visible on ${registry} but \`npm pack\` still can't fetch it (attempt ${attempt + 1}/${retries + 1}), ` +
        `retrying in ${(delay / 1000).toFixed(0)}s — likely tarball CDN propagation lag`,
      );
      await new Promise<void>(r => { setTimeout(r, delay); });
      packResult = spawnSync(
        'npm',
        ['pack', spec, '--registry', registry, '--pack-destination', tmpDir],
        { stdio: 'pipe', timeout },
      );
    }

    if (packResult.status !== 0) {
      const stderr = packResult.stderr?.toString().trim();
      issues.push(`Could not pull ${spec} back from ${registry} for verification${stderr ? `: ${stderr}` : ''}`);
      return { name: pkg.name, success: false, issues };
    }

    const tgzFile = readdirSync(tmpDir).find(f => f.endsWith('.tgz'));
    if (!tgzFile) {
      issues.push(`npm pack produced no tarball for ${spec} from ${registry}`);
      return { name: pkg.name, success: false, issues };
    }

    spawnSync('tar', ['xzf', tgzFile], { cwd: tmpDir, stdio: 'pipe' });
    const extractedDir = join(tmpDir, 'package');
    if (!existsSync(extractedDir)) {
      issues.push(`Failed to extract tarball for ${spec}`);
      return { name: pkg.name, success: false, issues };
    }

    issues.push(...verifyExtractedTarball(extractedDir));
  } catch (err) {
    issues.push(`Registry verification error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  return { name: pkg.name, success: issues.length === 0, issues };
}
