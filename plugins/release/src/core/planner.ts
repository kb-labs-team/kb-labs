/**
 * Release planner - detects changes and suggests version bumps
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import simpleGit from 'simple-git';
import semver from 'semver';
import globby from 'globby';
import { discoverSubRepoPaths } from '@kb-labs/sdk';
import type { PackageVersion, VersionBump, ReleaseConfig, ReleasePlan, ReleaseChannel } from './types';
import { applyVersionStrategy, applyCanarySuffix, type VersionStrategy } from './versioning-strategies';
import { buildReleaseTag } from './tag';

/**
 * Find the most recent git tag for a package.
 * When a flow is active, the pipeline's own tags follow `{flow}-v{version}`
 * (see tag.ts) — that pattern is tried FIRST via `flowTagGlob` (e.g.
 * `platform-v*`), since neither of the two fallbacks below ever matches it:
 * `pkgName@*` only matches legacy per-package scoped tags, and `v*` only
 * matches a bare lockstep tag with no flow prefix. Without this, bump
 * detection silently falls back to `v*` (or no tag at all) and scans commits
 * since a much older, unrelated release.
 */
async function findLastReleaseTag(
  git: ReturnType<typeof simpleGit>,
  pkgName: string,
  flowTagGlob?: string,
): Promise<string | null> {
  try {
    if (flowTagGlob) {
      const flowTags = await git.tags(['--sort=-version:refname', '--list', flowTagGlob]);
      if (flowTags.all.length > 0) {
        return flowTags.all[0]!;
      }
    }
    // Try package-scoped tag first: @kb-labs/foo@1.2.3
    const tags = await git.tags(['--sort=-version:refname', `--list`, `${pkgName}@*`]);
    if (tags.all.length > 0) {
      return tags.all[0]!;
    }
    // Try lockstep tag: v1.2.3
    const vTags = await git.tags(['--sort=-version:refname', '--list', 'v*']);
    if (vTags.all.length > 0) {
      return vTags.all[0]!;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get commits since last release tag, scoped to a path.
 * Returns empty array if git log fails.
 */
async function getCommitsSinceTag(
  git: ReturnType<typeof simpleGit>,
  pkgName: string,
  relPath: string,
  flowTagGlob?: string,
): Promise<string[]> {
  const lastTag = await findLastReleaseTag(git, pkgName, flowTagGlob);
  try {
    // git log [<tag>..HEAD] [--] <path>
    // Without a tag (initial release): git log -- <path>
    const args = ['log', '--format=%s', ...(lastTag ? [`${lastTag}..HEAD`] : []), '--', relPath];
    const raw = await git.raw(args);
    return raw.split('\n').map((s: string) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export interface PlannerOptions {
  cwd: string;
  config: ReleaseConfig;
  scope?: string;
  /** Named flow — selects a release config profile. Packages/versioning replace global values; checks are additive. */
  flow?: string;
  bumpOverride?: VersionBump;
  /** Release track. Defaults to 'stable'. See ReleaseChannel. */
  channel?: ReleaseChannel;
}

/**
 * Merge base config with a named flow's config.
 * Flow replaces packages/versioningStrategy and adds to checks. Matching check
 * ids override the global definition so a flow can make one gate stricter
 * without accidentally removing the global release contract.
 * All other config fields (registry, publish, rollback, git, changelog) remain from global.
 */
export function mergeConfigWithFlow(config: ReleaseConfig, flowName: string): ReleaseConfig {
  const flow = config.flows?.[flowName];
  if (!flow) {
    throw new Error(`Flow "${flowName}" is not defined in config.flows`);
  }
  return {
    ...config,
    ...(flow.packages !== undefined && { packages: flow.packages }),
    ...(flow.versioningStrategy && { versioningStrategy: flow.versioningStrategy }),
    ...(flow.checks !== undefined && {
      checks: [...new Map([...(config.checks ?? []), ...flow.checks].map(check => [check.id, check])).values()],
    }),
    ...(flow.build !== undefined && { build: flow.build }),
  };
}

/**
 * Check whether a specific package version is already published on the npm registry.
 * Fail-open: returns false on any network/registry error.
 */
export async function isVersionPublished(name: string, version: string, registry: string): Promise<boolean> {
  try {
    const encoded = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : name;
    const url = `${registry.replace(/\/$/, '')}/${encoded}/${version}`;
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Discover release-candidate packages for a scope, at their CURRENT
 * package.json version — no git-diff-based bump computation. Shared by
 * planRelease() (which then computes bumps on top) and `kb release
 * promote` (which needs the already-released versions as-is, since
 * recomputing bumps from git history would be wrong for a promote).
 */
export async function discoverCurrentPackages(
  cwd: string,
  scope: string | undefined,
  config: ReleaseConfig,
): Promise<PackageVersion[]> {
  const allPackages = await discoverPackages(cwd, config);

  if (!scope || scope === 'root') {
    return allPackages;
  }

  const isWorkspace = existsSync(join(cwd, '.gitmodules'));
  if (isWorkspace) {
    // In workspace mode, scope matches a sub-repo root.
    // Re-discover inside that sub-repo using standard discoverPackages (glob-based).
    const matchedRoots = filterByScope(allPackages, scope, config);
    const innerPackages: PackageVersion[] = [];
    for (const root of matchedRoots) {
      // Include root itself
      innerPackages.push(root);
      // Discover inner packages using standard glob logic (respects config, skips private)
      const inner = await discoverPackages(root.path, config);
      for (const pkg of inner) {
        if (!innerPackages.some(p => p.name === pkg.name)) {
          innerPackages.push(pkg);
        }
      }
    }
    return innerPackages;
  }

  return filterByScope(allPackages, scope, config);
}

/**
 * Plan release by detecting changes and computing version bumps
 */
export async function planRelease(options: PlannerOptions): Promise<ReleasePlan> {
  const { cwd, scope, bumpOverride, channel = 'stable' } = options;

  // Flow resolution — completely replaces packages/versioningStrategy/checks in config.
  // MUST happen before discoverPackages so globally-excluded packages can appear in a flow.
  const config = options.flow
    ? mergeConfigWithFlow(options.config, options.flow)
    : options.config;

  // This flow's own tag glob (e.g. `platform-v*`), so bump detection looks
  // for commits since the tag THIS pipeline actually creates (see tag.ts)
  // instead of falling back to an unrelated/stale tag pattern.
  const flowTagGlob = options.flow
    ? buildReleaseTag(options.flow, '*', config.flows?.[options.flow]?.tagPattern)
    : undefined;

  // Step 1-2: discover candidates and apply scope filtering.
  const packages = await discoverCurrentPackages(cwd, scope, config);

  // Workspace root with submodules: each sub-repo has its own git,
  // so we skip workspace-level detectModifiedPackages and use per-repo git.
  const isWorkspaceRoot = existsSync(join(cwd, '.gitmodules')) && !scope;

  let modifiedPackages: PackageVersion[];
  if (isWorkspaceRoot) {
    // All sub-repos are candidates — change detection happens per-repo
    modifiedPackages = packages;
  } else if (config.versioningStrategy === 'lockstep') {
    // Lockstep: all packages release together regardless of individual changes
    modifiedPackages = packages;
  } else {
    const git = simpleGit(cwd, { timeout: { block: 60000 } });
    modifiedPackages = await detectModifiedPackages(git, packages, cwd, flowTagGlob);
  }

  // Compute version bumps
  const registry = config.registry ?? 'https://registry.npmjs.org';
  let planPackages: PackageVersion[] = [];
  for (const pkg of modifiedPackages) {
    const bump = bumpOverride || config.bump || 'auto';

    // For workspace root, use per-sub-repo git instance
    const gitCwd = isWorkspaceRoot ? pkg.path : cwd;
    const git = simpleGit(gitCwd, { timeout: { block: 60000 } });

    let gitRoot = pkg.gitRoot;
    if (!gitRoot) {
      gitRoot = await git.revparse(['--show-toplevel']).catch(() => pkg.path);
    }

    // Idempotent check: if package.json was bumped beyond HEAD — by a previous
    // partial run, or by an earlier step in this same pipeline (e.g.
    // `release:version` ran before `release:git` re-plans) — trust that
    // version instead of computing another bump on top of it. Without this,
    // a fresh plan computed after an out-of-band bump silently drifts one
    // version past what's actually on disk: the tag/commit-message end up
    // one version ahead of what gets committed. assertTagVersionsMatchDisk()
    // in publisher.ts is the last-resort guard for this, but it only fires
    // right before tagging — after the (wrongly labeled) commit already
    // happened. isVersionPublished() is still checked, but only to populate
    // the informational `isPublished` field — not to gate the reuse.
    const pkgRelPath = relative(gitRoot, join(pkg.path, 'package.json'));
    const headPkgRaw = await git.raw(['show', `HEAD:${pkgRelPath}`]).catch(() => null);
    const headVersion: string | null = headPkgRaw ? (() => { try { return (JSON.parse(headPkgRaw) as { version?: string }).version ?? null; } catch { return null; } })() : null;

    if (headVersion && headVersion !== pkg.currentVersion) {
      const alreadyPublished = await isVersionPublished(pkg.name, pkg.currentVersion, registry);
      planPackages.push({
        ...pkg,
        gitRoot,
        nextVersion: pkg.currentVersion,
        bump: detectBumpType(headVersion, pkg.currentVersion),
        isPublished: alreadyPublished,
        // Mark the version as final so lockstep/adaptive resolution below
        // doesn't re-derive (and thus re-bump) it. `isPublished` alone is not
        // enough to signal this: the bump can legitimately be on disk but not
        // yet published — exactly the `release:version` → `release:git` case.
        versionPinned: true,
      });
      continue;
    }

    const nextVersion = await computeNextVersion(
      pkg.path,
      pkg.currentVersion,
      bump,
      git,
      gitCwd,
      pkg.name,
      flowTagGlob,
    );

    planPackages.push({
      ...pkg,
      gitRoot,
      nextVersion,
      bump: bump === 'auto' ? detectBumpType(pkg.currentVersion, nextVersion) : bump,
    });
  }

  // Apply versioning strategy (lockstep/independent/adaptive)
  // Scope-level override takes highest priority, then top-level, then legacy changelog.bumpStrategy
  const scopeVersioningStrategy = scope ? config.scopes?.[scope]?.versioningStrategy : undefined;
  const bumpStrategy = scopeVersioningStrategy || config.versioningStrategy || config.changelog?.bumpStrategy || 'independent';
  const versionStrategy = mapBumpStrategyToVersionStrategy(bumpStrategy);

  planPackages = applyVersionStrategy(planPackages, {
    strategy: versionStrategy,
    umbrellaPath: scope,
  });

  // Canary: suffix the already-computed base version with -canary.<shortsha>.
  // Runs last so canary and stable share the exact same bump-computation path.
  if (channel === 'canary') {
    const git = simpleGit(cwd, { timeout: { block: 60000 } });
    const shortSha = (await git.revparse(['--short', 'HEAD'])).trim();
    planPackages = applyCanarySuffix(planPackages, shortSha);
  }

  return {
    packages: planPackages,
    strategy: config.strategy || 'semver',
    registry: config.registry || 'https://registry.npmjs.org',
    rollbackEnabled: config.rollback?.enabled ?? true,
    channel,
    flow: options.flow,
    scope,
  };
}

/**
 * Map changelog.bumpStrategy to VersionStrategy
 */
function mapBumpStrategyToVersionStrategy(
  bumpStrategy: 'independent' | 'ripple' | 'lockstep' | 'adaptive'
): VersionStrategy {
  if (bumpStrategy === 'lockstep') {return 'lockstep';}
  if (bumpStrategy === 'ripple' || bumpStrategy === 'adaptive') {return 'adaptive';}
  return 'independent';
}

/**
 * Discover all release candidates according to config.packages (paths/include/exclude).
 * Does NOT apply scope filtering — that's done separately in filterByScope().
 */
async function discoverPackages(cwd: string, config?: ReleaseConfig): Promise<PackageVersion[]> {
  // Workspace root with .gitmodules → sub-repos are the release units
  const isWorkspaceRoot = existsSync(join(cwd, '.gitmodules'));
  if (isWorkspaceRoot) {
    return discoverSubRepoPackages(cwd, config);
  }

  const packages: PackageVersion[] = [];

  // Scan dirs from config.packages.paths, or full tree
  const configPaths = config?.packages?.paths;
  const pattern = configPaths?.length
    ? configPaths.map(p => `${p}/package.json`)
    : '**/package.json';

  const packageJsonPaths = await globby(pattern, {
    cwd,
    absolute: true,
    onlyFiles: true,
    ignore: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.git/**',
      '**/.*/**',
    ],
  });

  for (let i = 0; i < packageJsonPaths.length; i++) {
    if (i % 10 === 0) {
      await new Promise((resolve) => { setImmediate(resolve); });
    }

    const packageJsonPath = packageJsonPaths[i]!;
    const packagePath = join(packageJsonPath, '..');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
    const isRootPackageJson = packageJsonPath === join(cwd, 'package.json');

    if (packageJson.private) {continue;}
    if (isRootPackageJson && existsSync(join(packagePath, 'pnpm-workspace.yaml'))) {continue;}
    if (isRootPackageJson && !packageJson.name) {continue;}

    // Apply global include/exclude from config.packages
    const globalFilter = config?.packages;
    if (globalFilter?.include?.length || globalFilter?.exclude?.length) {
      const rel = relative(cwd, packagePath);
      if (globalFilter.include?.length && !matchesPackagePattern(packageJson.name, rel, globalFilter.include)) {continue;}
      if (globalFilter.exclude?.length && matchesPackagePattern(packageJson.name, rel, globalFilter.exclude)) {continue;}
    }

    packages.push({
      name: packageJson.name,
      path: packagePath,
      gitRoot: '',
      currentVersion: packageJson.version,
      nextVersion: packageJson.version,
      bump: 'auto',
      isPublished: false,
    });
  }

  // Deduplicate by package name — keep the entry with the shortest path
  // (avoids duplicates when nested package.json files share the same name)
  const seen = new Map<string, PackageVersion>();
  for (const pkg of packages) {
    const existing = seen.get(pkg.name);
    if (!existing || pkg.path.length < existing.path.length) {
      seen.set(pkg.name, pkg);
    }
  }

  return Array.from(seen.values());
}

/**
 * Filter discovered packages by scope with clear error messages.
 * Scope can be: exact name (@kb-labs/core), wildcard (@kb-labs/*), or path glob (packages/*).
 * Also applies per-scope include/exclude from config.scopes[scope].
 */
function filterByScope(
  packages: PackageVersion[],
  scope: string,
  config?: ReleaseConfig,
): PackageVersion[] {
  // Per-scope package overrides
  const scopeFilter = config?.scopes?.[scope]?.packages;
  const globalFilter = config?.packages;
  const mergedInclude = [...(globalFilter?.include ?? []), ...(scopeFilter?.include ?? [])];
  const mergedExclude = [...(globalFilter?.exclude ?? []), ...(scopeFilter?.exclude ?? [])];

  // Build scope matcher
  const isExactName = !scope.includes('*') && (scope.startsWith('@') || !scope.includes('/'));
  const scopeRegex = new RegExp(
    '^' + scope.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$'
  );

  const result: PackageVersion[] = [];

  for (const pkg of packages) {
    // Match by name or relative path depending on scope format
    const isPathPattern = scope.includes('/') && !scope.startsWith('@');
    const matchTarget = isPathPattern ? pkg.path : pkg.name;
    const matches = isExactName ? pkg.name === scope : scopeRegex.test(matchTarget);
    if (!matches) {continue;}

    // Apply per-scope include/exclude on top
    if (mergedInclude.length && !matchesPackagePattern(pkg.name, pkg.path, mergedInclude)) {continue;}
    if (mergedExclude.length && matchesPackagePattern(pkg.name, pkg.path, mergedExclude)) {continue;}

    result.push(pkg);
  }

  if (result.length === 0) {
    // Check if the scope would have matched something if not for exclude
    const wouldMatchExcluded = packages.some(p => {
      const matchTarget = isPathPattern(scope) ? p.path : p.name;
      const scopeMatches = isExactName ? p.name === scope : scopeRegex.test(matchTarget);
      if (!scopeMatches) {return false;}
      return mergedExclude.length > 0 && matchesPackagePattern(p.name, p.path, mergedExclude);
    });

    if (wouldMatchExcluded) {
      throw new Error(`Scope "${scope}" matches packages that are excluded by configuration`);
    }

    const globalInclude = globalFilter?.include;
    if (globalInclude?.length) {
      throw new Error(`Scope "${scope}" did not match any packages. Note: packages.include restricts discovery to: ${globalInclude.join(', ')}`);
    }

    throw new Error(`Scope "${scope}" did not match any discovered packages`);
  }

  return result;
}

function isPathPattern(scope: string): boolean {
  return scope.includes('/') && !scope.startsWith('@');
}

/**
 * Discover sub-repos as release units via .gitmodules.
 * Each sub-repo root package.json is a release unit (even if private).
 */
async function discoverSubRepoPackages(workspaceRoot: string, config?: ReleaseConfig): Promise<PackageVersion[]> {
  const subRepoPaths = discoverSubRepoPaths(workspaceRoot);
  const packages: PackageVersion[] = [];
  const globalFilter = config?.packages;

  for (const subRepoPath of subRepoPaths) {
    try {
      const pkgJson = JSON.parse(
        await readFile(join(subRepoPath, 'package.json'), 'utf-8')
      );
      if (!pkgJson.name) {continue;}

      const rel = relative(workspaceRoot, subRepoPath);

      // Apply global include/exclude
      if (globalFilter?.include?.length && !matchesPackagePattern(pkgJson.name, rel, globalFilter.include)) {continue;}
      if (globalFilter?.exclude?.length && matchesPackagePattern(pkgJson.name, rel, globalFilter.exclude)) {continue;}

      packages.push({
        name: pkgJson.name,
        path: subRepoPath,
        gitRoot: subRepoPath,
        currentVersion: pkgJson.version || '0.0.0',
        nextVersion: pkgJson.version || '0.0.0',
        bump: 'auto',
        isPublished: false,
      });
    } catch {
      // Sub-repo without valid package.json — skip
    }
  }

  return packages;
}

/**
 * Check if file should be ignored (node_modules, dist, etc.)
 */
function shouldIgnoreFile(file: string): boolean {
  const ignoredPaths = [
    'node_modules/',
    '.git/',
    'dist/',
    'build/',
    '.next/',
    '.nuxt/',
    'coverage/',
    '.cache/',
    'tmp/',
  ];

  return ignoredPaths.some(path => file.includes(path));
}

async function detectModifiedPackages(
  git: ReturnType<typeof simpleGit>,
  packages: PackageVersion[],
  cwd: string,
  flowTagGlob?: string,
): Promise<PackageVersion[]> {
  // `git status` is repository-wide. Running it once per package made planning
  // scale linearly in process launches before we even inspected release tags.
  const status = await git.status();
  const changedPaths = status.files.map(file => file.path);

  return (await Promise.all(packages.map(async (pkg) => {
    const pkgRel = relative(resolve(cwd), resolve(pkg.path));
    const hasUncommitted = changedPaths.some(path => path === pkgRel || path.startsWith(pkgRel + '/'));
    if (hasUncommitted) {
      return pkg;
    }

    const commits = await getCommitsSinceTag(git, pkg.name, pkgRel, flowTagGlob);
    return commits.length > 0 ? pkg : null;
  }))).filter((pkg): pkg is PackageVersion => pkg !== null);
}

async function computeNextVersion(
  packagePath: string,
  currentVersion: string,
  bump: VersionBump,
  git: ReturnType<typeof simpleGit>,
  gitCwd: string,
  pkgName: string,
  flowTagGlob?: string,
): Promise<string> {
  if (bump === 'auto') {
    const detectedBump = await detectVersionFromCommits(git, packagePath, gitCwd, pkgName, flowTagGlob);
    // No commits since the last matching release tag — most commonly because
    // HEAD *is* the last release tag (e.g. a CI job re-running `release
    // version` against an already-tagged, already-committed release commit,
    // such as the "Apply planned package versions" step in
    // release-build-candidate.yml). There is nothing to bump: inventing a
    // patch bump here would silently re-version a release that was already
    // planned, committed, and tagged. See versioning-strategies.ts's
    // getMaxBump()/applyLockstep() for the matching lockstep-side handling.
    if (detectedBump === 'none') {return currentVersion;}
    return semver.inc(currentVersion, detectedBump) || currentVersion;
  }
  if (bump === 'none') {return currentVersion;}
  return semver.inc(currentVersion, bump) || currentVersion;
}

async function detectVersionFromCommits(
  git: ReturnType<typeof simpleGit>,
  packagePath: string,
  gitCwd: string,
  pkgName: string,
  flowTagGlob?: string,
): Promise<'major' | 'minor' | 'patch' | 'none'> {
  try {
    const relPath = relative(resolve(gitCwd), resolve(packagePath));
    const messages = await getCommitsSinceTag(git, pkgName, relPath, flowTagGlob);

    // Zero commits since the last release tag means nothing changed for this
    // package since it was last released — 'auto' must not invent a bump out
    // of thin air (previously this defaulted to 'patch', which is what
    // produced e.g. 2.119.0 -> 2.119.1 when re-planning at the exact tagged
    // commit: `getCommitsSinceTag` found the just-created tag as "last
    // release tag", the range against HEAD was empty, and the old fallback
    // still returned 'patch').
    if (messages.length === 0) {return 'none';}

    let hasMinor = false;
    let hasBreaking = false;

    for (const message of messages) {
      const msg = message.toLowerCase();
      if (msg.includes('!:') || msg.includes('breaking change')) {
        hasBreaking = true;
      } else if (msg.startsWith('feat') || msg.startsWith('feature')) {
        hasMinor = true;
      }
    }

    if (hasBreaking) {return 'major';}
    if (hasMinor) {return 'minor';}
    return 'patch';
  } catch {
    return 'patch';
  }
}

function detectBumpType(currentVersion: string, nextVersion: string): VersionBump {
  if (currentVersion === nextVersion) {
    return 'none';
  }
  if (semver.major(currentVersion) < semver.major(nextVersion)) {
    return 'major';
  }
  if (semver.minor(currentVersion) < semver.minor(nextVersion)) {
    return 'minor';
  }
  return 'patch';
}

/**
 * Match a package against a list of patterns.
 * - Patterns starting with '@' or without '/' → matched against package name.
 * - Patterns containing '/' (non-scoped) → matched against relative path.
 * - Supports '*' wildcard (single path segment, not separator).
 */
export function matchesPackagePattern(pkgName: string, relativePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const isPathPattern = pattern.includes('/') && !pattern.startsWith('@');
    const target = isPathPattern ? relativePath : pkgName;
    const regex = new RegExp(
      '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$'
    );
    if (regex.test(target)) {return true;}
  }
  return false;
}
