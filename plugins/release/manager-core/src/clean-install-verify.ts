/**
 * Verify a packed tarball actually installs — and imports — in a clean,
 * outside-the-workspace consumer. This is the strongest guarantee available:
 * it catches everything the static findForbiddenDependencyProtocols() check
 * can (a literal workspace:/link:/file: protocol) PLUS classes that check
 * can't, most importantly an already-published PEER dependency that is
 * itself broken (npm auto-installs peers, so a bad manifest several levels
 * deep in someone else's graph fails this package's install too).
 *
 * The package manager is configurable. pnpm is the platform default and is
 * used for the monorepo release flow; npm remains available for projects that
 * explicitly publish with npm.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface CleanInstallResult {
  ok: boolean;
  /** Human-readable reason, always populated when ok is false. */
  error?: string;
}

/**
 * Install `tarballPath` into a throwaway consumer project (outside the
 * monorepo workspace, so pnpm's workspace resolution can't mask a problem)
 * and confirm `packageName` can actually be imported afterward.
 *
 * `registry`, when set, overrides where the consumer resolves ALL
 * dependencies from (not just `packageName` itself) — used by the
 * `pack-install` release gate to point at a local staging registry that
 * carries the release plan's not-yet-published internal sibling versions.
 * Third-party dependencies still resolve correctly through that registry's
 * uplink to the real npm registry.
 */
export async function verifyCleanInstall(
  tarballPath: string,
  packageName: string,
  additionalTarballs: string[] = [],
  packageManager: 'pnpm' | 'npm' = 'npm',
  registry?: string,
): Promise<CleanInstallResult> {
  const consumerDir = mkdtempSync(join(tmpdir(), 'kb-clean-install-'));
  try {
    if (packageManager === 'pnpm') {
      const stagedTarballs = [tarballPath, ...additionalTarballs];
      const targetName = readPackedPackageName(tarballPath);
      if (!targetName) {
        return { ok: false, error: `install failed: cannot read package name from ${tarballPath}` };
      }
      const dependencies: Record<string, string> = { [targetName]: `file:${tarballPath}` };
      const overrides: Record<string, string> = {};
      for (const stagedTarball of stagedTarballs) {
        const name = readPackedPackageName(stagedTarball);
        if (!name) {
          return { ok: false, error: `install failed: cannot read package name from ${stagedTarball}` };
        }
        overrides[name] = `file:${stagedTarball}`;
      }
      writeFileSync(
        join(consumerDir, 'package.json'),
        JSON.stringify({ name: 'kb-release-consumer', private: true, dependencies, pnpm: { overrides } }, null, 2) + '\n',
      );
      if (registry) {
        writeFileSync(join(consumerDir, '.npmrc'), `registry=${registry}\n`);
      }
      const install = spawnSync(
        'pnpm',
        ['install', '--ignore-scripts', '--no-lockfile', '--config.auto-install-peers=true'],
        { cwd: consumerDir, stdio: 'pipe', timeout: 120_000 },
      );
      if (install.status !== 0) {
        return { ok: false, error: `install failed: ${describeProcessFailure(install)}` };
      }
    } else {
      writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({ name: 'kb-release-consumer', private: true }) + '\n');
      // Lazy import: Arborist is only needed for the explicit npm path.
      const { Arborist } = await import('@npmcli/arborist');
      // audit:false — reify() otherwise submits a bulk security-advisory
      // request to the registry and unconditionally awaits it before
      // returning (see @npmcli/arborist reify.js: `this.auditReport = await
      // this.auditReport`), even though this call site never reads
      // arb.auditReport. That's a real network round-trip per package with
      // zero bearing on what this check verifies (a broken manifest fails
      // the same way — via reify() itself throwing — regardless of the
      // audit flag), measured ~15-20% of total install time removed in a
      // repeated, alternating before/after comparison on this machine.
      const arb = new Arborist({ path: consumerDir, ignoreScripts: true, audit: false, ...(registry ? { registry } : {}) });
      try {
        await arb.reify({ add: [tarballPath, ...additionalTarballs], save: false });
      } catch (err) {
        return { ok: false, error: `install failed: ${describeArboristError(err)}` };
      }
    }

    const importCheck = spawnSync(
      'node',
      ['--input-type=module', '-e', 'await import(process.argv[1])', packageName],
      { cwd: consumerDir, stdio: 'pipe', timeout: 15_000 },
    );
    if (importCheck.status !== 0) {
      const stderr = importCheck.stderr?.toString().trim();
      return { ok: false, error: `clean consumer cannot import ${packageName}${stderr ? `: ${stderr}` : ''}` };
    }

    return { ok: true };
  } finally {
    rmSync(consumerDir, { recursive: true, force: true });
  }
}

function readPackedPackageName(tarballPath: string): string | undefined {
  const result = spawnSync('tar', ['xOf', tarballPath, 'package/package.json'], { stdio: 'pipe' });
  if (result.status !== 0) { return undefined; }
  try {
    const manifest = JSON.parse(result.stdout.toString()) as { name?: unknown };
    return typeof manifest.name === 'string' ? manifest.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Arborist errors are plain Error instances with a useful .message and,
 * for npm-package-arg failures, a .code (e.g. EUNSUPPORTEDPROTOCOL). Surface
 * both — the code alone ("EUNSUPPORTEDPROTOCOL") is what npm's own debug log
 * would have shown if it hadn't swallowed the message entirely.
 */
export function describeArboristError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `[${code}] ${err.message}` : err.message;
  }
  return String(err);
}

function describeProcessFailure(result: { stderr?: Buffer | string; stdout?: Buffer | string; status: number | null }): string {
  const stderr = result.stderr?.toString().trim();
  const stdout = result.stdout?.toString().trim();
  return stderr || stdout || `package manager exited with code ${result.status ?? 'unknown'}`;
}
