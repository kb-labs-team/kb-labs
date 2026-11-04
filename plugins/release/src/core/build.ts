/**
 * Safe build — builds into temp dir, then atomically swaps dist/.
 * Prevents crashing running services whose dist/ is wiped by tsup's `clean: true`.
 */

import { rename, rm, cp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { BuildResult, PackageVersion, PluginLogger, ReleaseShell } from './types';
import { topoSortForBuild } from './dep-order';

/**
 * Build all packages in a plan using safe build strategy.
 * Stops on first failure.
 *
 * Packages are topologically sorted first so an intra-release dependency
 * (e.g. @kb-labs/sdk) always builds before its dependants — otherwise a
 * dependant can fail to resolve the dependency's subpath exports in a
 * fresh worktree where nothing has a pre-existing dist/ yet.
 */
export async function buildPackages(
  packages: PackageVersion[],
  options: {
    logger?: PluginLogger;
    shell: ReleaseShell;
    onProgress?: (pkg: string, result: BuildResult) => void;
  },
): Promise<BuildResult[]> {
  const results: BuildResult[] = [];
  const ordered = topoSortForBuild(packages);

  for (const pkg of ordered) {
    options?.logger?.info?.(`Building ${pkg.name}...`);
    const result = await runSafeBuild(pkg.path, pkg.name, options.shell);
    results.push({ ...result, name: pkg.name });

    options?.onProgress?.(pkg.name, { ...result, name: pkg.name });

    if (!result.success) {
      options?.logger?.error?.(`Build failed for ${pkg.name}: ${result.error}`);
      break;
    }

    options?.logger?.info?.(`Built ${pkg.name} in ${result.durationMs}ms`);
  }

  return results;
}

/**
 * Run build for a single package using safe temp-dir strategy when tsup is detected.
 * Falls back to regular `pnpm run build` for non-tsup packages.
 */
export async function runSafeBuild(packagePath: string, packageName: string, shell: ReleaseShell): Promise<BuildResult> {
  const usesTsup = existsSync(join(packagePath, 'tsup.config.ts'))
    || existsSync(join(packagePath, 'tsup.config.js'));

  // The temp-dir/atomic-swap trick below only protects a build whose *entire*
  // output comes from a single `tsup` invocation, because it runs `npx tsup
  // -d tempDir` directly instead of the package's own `build` script — that
  // substitution is only equivalent to the real build when the real build
  // *is* bare tsup. A compound script (e.g. studio-app's
  // "rspack build && tsup src/manifest.ts") has other steps whose output
  // this path silently drops: running `npx tsup -d tempDir` alone builds
  // only the manifest and never invokes rspack, so the SPA bundle never
  // lands in dist/ — the published package ends up with just
  // dist/manifest.js and no index.html/assets, and the installed service
  // starts (serving 404s from an empty dist/) but never becomes healthy.
  // This was confirmed against the real published 2.119.0 @kb-labs/studio-app
  // tarball, which contained exactly that: dist/manifest.js and nothing else.
  //
  // So only take the safe temp-dir path when `build` is a bare tsup call;
  // anything else must run through its own script (runDirectBuild), trusting
  // that script to manage its own dist/ safety — as studio-app's
  // tsup.config.ts already does by pinning `clean: false` specifically so
  // its tsup step doesn't wipe the rspack output that ran before it.
  if (usesTsup && (await isBareTsupBuildScript(packagePath))) {
    return runTsupSafeBuild(packagePath, packageName, shell);
  }

  return runDirectBuild(packagePath, packageName, shell);
}

/**
 * True when the package's `build` script is nothing more than a plain
 * `tsup` invocation (optionally with flags) — i.e. safe to replace with
 * `npx tsup -d <tempDir>` without silently dropping other build steps.
 */
async function isBareTsupBuildScript(packagePath: string): Promise<boolean> {
  try {
    const raw = await readFile(join(packagePath, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const buildScript = pkg.scripts?.build?.trim();
    if (!buildScript) {
      return false;
    }
    // Reject anything chaining multiple commands (&&, ||, ;, |) or invoking
    // another tool alongside tsup.
    if (/&&|\|\||;|\|/.test(buildScript)) {
      return false;
    }
    return /^(npx\s+)?tsup(\s|$)/.test(buildScript);
  } catch {
    // No readable package.json / build script — don't risk the fast path.
    return false;
  }
}

/**
 * Check if a shell command is a build command that should use safe build.
 */
export function isBuildCommand(command: string, args?: string[]): boolean {
  const full = [command, ...(args ?? [])].join(' ').trim();
  return /\b(pnpm|npm|yarn)\s+(run\s+)?build\b/.test(full);
}

async function runTsupSafeBuild(packagePath: string, packageName: string, shell: ReleaseShell): Promise<BuildResult> {
  const startTime = Date.now();
  const buildId = randomBytes(6).toString('hex');
  const tempDir = join(tmpdir(), `kb-release-build-${buildId}`);
  const distDir = join(packagePath, 'dist');
  const backupDir = join(packagePath, `dist.bak-${buildId}`);

  try {
    const buildResult = await executeCommand(shell, 'npx', ['tsup', '-d', tempDir], packagePath, 5 * 60 * 1000);

    if (!buildResult.success) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      return { ...buildResult, name: packageName, durationMs: Date.now() - startTime };
    }

    if (existsSync(distDir)) {
      await rename(distDir, backupDir);
    }

    try {
      await rename(tempDir, distDir);
    } catch {
      await cp(tempDir, distDir, { recursive: true });
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    return { success: true, name: packageName, durationMs: Date.now() - startTime };
  } catch (err) {
    if (existsSync(backupDir) && !existsSync(distDir)) {
      await rename(backupDir, distDir).catch(() => {});
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return {
      success: false,
      name: packageName,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }
}

async function runDirectBuild(packagePath: string, packageName: string, shell: ReleaseShell): Promise<BuildResult> {
  // NODE_ENV=production disables Module Federation dts type generation in
  // Studio rspack configs (createStudioRemoteConfig, studio/plugin-tools) —
  // a dev-only convenience of no value here, and a reproducible source of
  // indefinite native-threadpool hangs under concurrent rspack builds. See
  // the same fix in manager-cli/src/cli/commands/build.ts for the
  // `build.script`-configured path.
  const result = await executeCommand(shell, 'pnpm', ['run', 'build'], packagePath, 5 * 60 * 1000, { NODE_ENV: 'production' });
  return { ...result, name: packageName };
}

export function formatBuildFailureOutput(stdout: string, stderr: string, exitCode: number): string {
  const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
  return combined.split('\n').slice(-30).join('\n') || `Build failed with exit code ${exitCode}`;
}

export interface SpawnResult extends Omit<BuildResult, 'name'> {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn a shell command and collect results.
 * Captures both stdout and stderr — build tools often write errors to stdout.
 */
async function executeCommand(shell: ReleaseShell, command: string, args: string[], cwd: string, timeoutMs: number, env?: Record<string, string>): Promise<SpawnResult> {
  const startTime = Date.now();
  const result = await shell.exec(command, args, { cwd, timeout: timeoutMs, ...(env ? { env } : {}) });
  const exitCode = result.code;
  return {
    success: result.ok,
    error: result.ok ? undefined : formatBuildFailureOutput(result.stdout, result.stderr, exitCode),
    durationMs: Date.now() - startTime,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode,
  };
}
