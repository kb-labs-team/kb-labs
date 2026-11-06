import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { matchesPackagePattern } from '../../src/core/planner';
import { planRelease } from '../../src/core/planner';

// ─── matchesPackagePattern ────────────────────────────────────────────────────

describe('matchesPackagePattern', () => {
  describe('package name patterns', () => {
    it('matches exact name', () => {
      expect(matchesPackagePattern('@kb-labs/devkit', 'infra/kb-labs-devkit', ['@kb-labs/devkit'])).toBe(true);
    });

    it('does not match different name', () => {
      expect(matchesPackagePattern('@kb-labs/core', 'packages/core', ['@kb-labs/devkit'])).toBe(false);
    });

    it('matches wildcard scope pattern', () => {
      expect(matchesPackagePattern('@kb-labs/core', 'packages/core', ['@kb-labs/*'])).toBe(true);
    });

    it('wildcard scope does not match other scope', () => {
      expect(matchesPackagePattern('@my-org/core', 'packages/core', ['@kb-labs/*'])).toBe(false);
    });

    it('matches suffix wildcard', () => {
      expect(matchesPackagePattern('@kb-labs/plugin-template-core', 'packages/plugin-template-core', ['@kb-labs/plugin-template-*'])).toBe(true);
    });

    it('suffix wildcard does not match non-matching name', () => {
      expect(matchesPackagePattern('@kb-labs/plugin-execution', 'packages/plugin-execution', ['@kb-labs/plugin-template-*'])).toBe(false);
    });

    it('matches unscoped package name', () => {
      expect(matchesPackagePattern('my-pkg', 'packages/my-pkg', ['my-pkg'])).toBe(true);
    });
  });

  describe('path patterns', () => {
    it('matches path glob', () => {
      expect(matchesPackagePattern('@kb-labs/core', 'packages/core', ['packages/*'])).toBe(true);
    });

    it('does not match different dir', () => {
      expect(matchesPackagePattern('@kb-labs/core', 'apps/core', ['packages/*'])).toBe(false);
    });

    it('matches nested path', () => {
      expect(matchesPackagePattern('@kb-labs/adapters-fs', 'infra/kb-labs-adapters/packages/adapters-fs', ['infra/kb-labs-adapters/packages/*'])).toBe(true);
    });
  });

  describe('multiple patterns', () => {
    it('returns true if any pattern matches', () => {
      expect(matchesPackagePattern('@kb-labs/devkit', 'infra/devkit', ['@kb-labs/core', '@kb-labs/devkit'])).toBe(true);
    });

    it('returns false if no pattern matches', () => {
      expect(matchesPackagePattern('@kb-labs/other', 'packages/other', ['@kb-labs/core', '@kb-labs/devkit'])).toBe(false);
    });
  });
});

// ─── discoverPackages via planRelease ─────────────────────────────────────────

function makeTmpMonorepo(packages: Array<{ name: string; version?: string; dir?: string }>): string {
  const root = join(tmpdir(), `kb-planner-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(root, { recursive: true });

  // Init git repo so simple-git doesn't throw
  execSync('git init -q', { cwd: root });
  execSync('git config user.email "test@test.com"', { cwd: root });
  execSync('git config user.name "Test"', { cwd: root });
  // Need at least one commit so HEAD exists
  writeFileSync(join(root, '.gitkeep'), '');
  execSync('git add .gitkeep', { cwd: root });
  execSync('git commit -m "init" --allow-empty', { cwd: root });

  // Root package.json without name (workspace manifest)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  // pnpm-workspace.yaml marker (causes root to be skipped)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');

  for (const pkg of packages) {
    const dir = pkg.dir ?? join('packages', pkg.name.replace(/^@[^/]+\//, ''));
    const pkgDir = join(root, dir);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: pkg.name,
      version: pkg.version ?? '1.0.0',
    }));
    // Minimal dist so verifier doesn't complain (planner doesn't need it)
  }

  return root;
}

describe('planRelease — packages filter', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpMonorepo([
      { name: '@scope/alpha' },
      { name: '@scope/beta' },
      { name: '@scope/devkit' },
      { name: '@scope/gamma', dir: 'apps/gamma' },
    ]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('discovers all non-private packages by default', async () => {
    const plan = await planRelease({ cwd: root, config: {} });
    const names = plan.packages.map(p => p.name).sort();
    expect(names).toContain('@scope/alpha');
    expect(names).toContain('@scope/beta');
    expect(names).toContain('@scope/devkit');
    expect(names).toContain('@scope/gamma');
  });

  it('exclude removes specific package by name', async () => {
    const plan = await planRelease({
      cwd: root,
      config: { packages: { exclude: ['@scope/devkit'] } },
    });
    const names = plan.packages.map(p => p.name);
    expect(names).not.toContain('@scope/devkit');
    expect(names).toContain('@scope/alpha');
  });

  it('exclude supports wildcard', async () => {
    const plan = await planRelease({
      cwd: root,
      config: { packages: { exclude: ['@scope/d*'] } },
    });
    const names = plan.packages.map(p => p.name);
    expect(names).not.toContain('@scope/devkit');
    expect(names).toContain('@scope/alpha');
  });

  it('include restricts to matching packages only', async () => {
    const plan = await planRelease({
      cwd: root,
      config: { packages: { include: ['@scope/alpha', '@scope/beta'] } },
    });
    const names = plan.packages.map(p => p.name).sort();
    expect(names).toEqual(['@scope/alpha', '@scope/beta']);
  });

  it('paths restricts discovery to given dirs', async () => {
    const plan = await planRelease({
      cwd: root,
      config: { packages: { paths: ['packages/*'] } },
    });
    const names = plan.packages.map(p => p.name);
    // apps/gamma should not appear
    expect(names).not.toContain('@scope/gamma');
    expect(names).toContain('@scope/alpha');
  });

  it('per-scope exclude merges with global exclude', async () => {
    // scope here is a wildcard pattern matching package names (e.g. '@scope/*')
    // so all @scope/* packages pass the scope filter, then per-scope packages
    // config for '@scope/*' applies on top of global exclude
    const plan = await planRelease({
      cwd: root,
      config: {
        packages: { exclude: ['@scope/devkit'] },
        scopes: {
          '@scope/*': { packages: { exclude: ['@scope/alpha'] } },
        },
      },
      scope: '@scope/*',
    });
    const names = plan.packages.map(p => p.name);
    expect(names).not.toContain('@scope/devkit'); // global exclude
    expect(names).not.toContain('@scope/alpha');  // scope exclude
    expect(names).toContain('@scope/beta');
  });
});

describe('planRelease — channel', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpMonorepo([{ name: '@scope/alpha' }, { name: '@scope/beta' }]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('defaults to the stable channel and leaves nextVersion unsuffixed', async () => {
    const plan = await planRelease({ cwd: root, config: {} });
    expect(plan.channel).toBe('stable');
    for (const pkg of plan.packages) {
      expect(pkg.nextVersion).not.toContain('-canary.');
    }
  });

  it('canary channel sets plan.channel and suffixes each package version with -canary.<shortsha>', async () => {
    const shortSha = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
    const plan = await planRelease({ cwd: root, config: {}, channel: 'canary' });
    expect(plan.channel).toBe('canary');
    expect(plan.packages.length).toBeGreaterThan(0);
    for (const pkg of plan.packages) {
      expect(pkg.nextVersion).toBe(`${pkg.nextVersion.split('-canary.')[0]}-canary.${shortSha}`);
      expect(pkg.nextVersion.endsWith(`-canary.${shortSha}`)).toBe(true);
    }
  });
});

// ─── planRelease — flow-tag-aware bump detection ──────────────────────────────
//
// Reproduces the "bump detection scans since a stale/unrelated tag" bug: the
// pipeline's own release tags follow `{flow}-v{version}` (tag.ts), but
// findLastReleaseTag only ever looked for `<pkgName>@*` or a bare `v*` tag —
// neither of which a flow tag like `myflow-v1.0.0` matches. That made bump
// detection scan ALL history (or a much older tag) instead of "since the
// last release", inflating the detected bump every single run.
describe('planRelease — flow tag detection', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpMonorepo([{ name: '@scope/alpha' }]);
    // Commit the package as it stands (version 1.0.0) so it's not picked up
    // as "uncommitted" — that path bypasses tag-based bump detection entirely.
    execSync('git add -A && git commit -m "chore: commit initial packages"', { cwd: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('only scans commits after this flow\'s own tag, not full history', async () => {
    const pkgDir = join(root, 'packages', 'alpha');

    // A feature commit BEFORE the flow's release tag — must NOT count towards
    // this run's bump.
    writeFileSync(join(pkgDir, 'feature.txt'), 'x');
    execSync('git add -A && git commit -m "feat: add feature"', { cwd: root });
    execSync('git tag myflow-v1.0.0', { cwd: root });

    // A fix commit AFTER the tag — this is the only commit that should count.
    writeFileSync(join(pkgDir, 'fix.txt'), 'y');
    execSync('git add -A && git commit -m "fix: patch bug"', { cwd: root });

    const plan = await planRelease({
      cwd: root,
      config: { flows: { myflow: {} } },
      flow: 'myflow',
    });

    const alpha = plan.packages.find(p => p.name === '@scope/alpha');
    expect(alpha).toBeDefined();
    // Without flow-tag-aware detection, the pre-tag "feat" commit would still
    // be in range, incorrectly producing a minor bump (1.1.0) instead of patch.
    expect(alpha!.bump).toBe('patch');
    expect(alpha!.nextVersion).toBe('1.0.1');
  });
});

// ─── idempotent re-plan after an out-of-band bump ─────────────────────────────
//
// Regression for a real incident: `release:version` bumps package.json on
// disk (1.0.0 -> 1.1.0) without committing, then a later, separate CLI
// invocation (`release:git`) calls planRelease() fresh. Before the fix,
// planRelease saw currentVersion=1.1.0 (already ahead of HEAD's 1.0.0) and
// computed ANOTHER bump on top of it (-> 1.2.0), so the git tag/commit
// message ended up one version ahead of what was actually committed.

describe('planRelease — idempotent re-plan after external bump', () => {
  it('reuses the on-disk version instead of bumping again when package.json is already ahead of HEAD', async () => {
    // realpathSync: on macOS, os.tmpdir() returns an unresolved /var/... path
    // while `git rev-parse --show-toplevel` resolves the /var -> /private/var
    // symlink. planner.ts diffs pkg.path against the resolved gitRoot via
    // path.relative(), so a mismatched prefix here breaks that comparison
    // (produces a bogus path git can't find at HEAD) — resolve up front so
    // this test exercises the real HEAD-vs-disk diff, not a path artifact.
    const root = realpathSync(makeTmpMonorepo([{ name: '@scope/alpha', version: '1.0.0' }]));
    try {
      // Commit the package at 1.0.0 so HEAD has a real version to diff against.
      execSync('git add -A && git commit -q -m "init pkg"', { cwd: root });

      // Simulate an earlier pipeline step (`release:version`) bumping the
      // package on disk without committing — package.json is now ahead of HEAD.
      const pkgPath = join(root, 'packages', 'alpha', 'package.json');
      writeFileSync(pkgPath, JSON.stringify({ name: '@scope/alpha', version: '1.1.0' }));

      const plan = await planRelease({ cwd: root, config: {}, bumpOverride: 'minor' });

      const pkg = plan.packages.find(p => p.name === '@scope/alpha');
      expect(pkg).toBeDefined();
      // Must reuse 1.1.0 as-is — NOT compute another minor bump to 1.2.0.
      expect(pkg!.nextVersion).toBe('1.1.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── auto-bump at an already-tagged, already-committed release commit ────────
//
// Regression for the real incident this reproduces: `release-build-candidate.yml`
// checks out the EXACT commit `release-prepare` already committed and tagged
// (e.g. `platform-v2.119.0`), then runs `pnpm kb release version update --flow
// platform --json` with NO `--bump` flag (defaults to 'auto') to "apply
// planned package versions". At that checkout, HEAD's package.json and disk's
// package.json are identical (nothing to trust-disk-over), and the newest
// matching release tag IS the checked-out commit itself, so there are zero
// commits in the `<tag>..HEAD` range. The old `detectVersionFromCommits()`
// defaulted an empty commit range to 'patch' (instead of "nothing to bump"),
// and lockstep's `getMaxBump()` floored at 'patch' even when every package
// resolved to 'none' — together they silently re-bumped an already-released,
// unchanged commit by one patch (2.119.0 -> 2.119.1), which then failed
// "Verify sealed platform version" against the tag/plan's 2.119.0.
describe('planRelease — auto bump at an already-tagged commit (idempotent CI re-run)', () => {
  it('does not invent a bump when HEAD is exactly the last matching release tag (independent strategy)', async () => {
    const root = realpathSync(makeTmpMonorepo([{ name: '@scope/alpha', version: '2.119.0' }]));
    try {
      execSync('git add -A && git commit -q -m "chore(release): publish alpha"', { cwd: root });
      execSync('git tag myflow-v2.119.0', { cwd: root });

      // No further commits — this IS the tagged commit, exactly like the CI
      // "checkout exact intent commit" step. Under the independent strategy,
      // detectModifiedPackages() drops packages with no uncommitted changes
      // and no commits since their last tag before bump computation even
      // runs, so the package legitimately does not appear in the plan at
      // all — there is nothing to bump, which is the same "no invented
      // bump" property the lockstep case below asserts more directly.
      const plan = await planRelease({
        cwd: root,
        config: { flows: { myflow: {} } },
        flow: 'myflow',
        // No bumpOverride — mirrors the CI workflow step, which passes no
        // --bump flag and so falls through to 'auto'.
      });

      expect(plan.packages).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not invent a bump when HEAD is exactly the last matching release tag (lockstep strategy)', async () => {
    const root = realpathSync(makeTmpMonorepo([
      { name: '@scope/alpha', version: '2.119.0' },
      { name: '@scope/beta', version: '2.119.0' },
    ]));
    try {
      execSync('git add -A && git commit -q -m "chore(release): publish 2 packages"', { cwd: root });
      execSync('git tag platform-v2.119.0', { cwd: root });

      const plan = await planRelease({
        cwd: root,
        config: { flows: { platform: { versioningStrategy: 'lockstep' } } },
        flow: 'platform',
      });

      expect(plan.packages.map(p => p.nextVersion)).toEqual(['2.119.0', '2.119.0']);
      expect(plan.packages.every(p => p.bump === 'none')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
