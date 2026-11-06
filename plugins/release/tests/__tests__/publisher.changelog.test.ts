import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { copyChangelogToPackages, mergeRootChangelog } from '../../src/core/publisher';
import type { PackageVersion, ReleasePlan } from '../../src/core/types';

function makePkg(overrides: Partial<PackageVersion> & { name: string; path: string }): PackageVersion {
  return {
    gitRoot: '/tmp',
    currentVersion: '1.0.0',
    nextVersion: '1.1.0',
    bump: 'minor',
    isPublished: false,
    ...overrides,
  };
}

describe('copyChangelogToPackages — lockstep releases', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `kb-changelog-test-${randomBytes(4).toString('hex')}`);
    mkdirSync(join(root, 'alpha'), { recursive: true });
    mkdirSync(join(root, 'beta'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the full consolidated changelog to every package, not an empty per-package extract', async () => {
    const plan: ReleasePlan = {
      packages: [
        makePkg({ name: '@scope/alpha', path: join(root, 'alpha') }),
        makePkg({ name: '@scope/beta', path: join(root, 'beta') }),
      ],
      strategy: 'semver',
      registry: 'https://registry.npmjs.org',
      rollbackEnabled: true,
      channel: 'stable',
    };

    // Real shape produced by changelog-generator.ts for a lockstep release —
    // a single consolidated header, no per-package sections.
    const lockstepChangelog = [
      '## [1.1.0] - 2026-01-01',
      '',
      '**2 packages** bumped to v1.1.0',
      '',
      '### ✨ New Features',
      '',
      '- **alpha**: does a new thing',
    ].join('\n');

    await copyChangelogToPackages({ cwd: root, plan, changelog: lockstepChangelog });

    const alphaPath = join(root, 'alpha', 'CHANGELOG.md');
    const betaPath = join(root, 'beta', 'CHANGELOG.md');
    expect(existsSync(alphaPath)).toBe(true);
    expect(existsSync(betaPath)).toBe(true);

    const alphaContent = readFileSync(alphaPath, 'utf-8');
    const betaContent = readFileSync(betaPath, 'utf-8');
    expect(alphaContent).toContain('New Features');
    expect(alphaContent).toContain('does a new thing');
    expect(betaContent).toContain('New Features');
  });

  it('replaces the existing version section on re-run instead of duplicating it', async () => {
    const plan: ReleasePlan = {
      packages: [
        makePkg({ name: '@scope/alpha', path: join(root, 'alpha') }),
        makePkg({ name: '@scope/beta', path: join(root, 'beta') }),
      ],
      strategy: 'semver',
      registry: 'https://registry.npmjs.org',
      rollbackEnabled: true,
      channel: 'stable',
    };

    const firstRun = '## [1.1.0] - 2026-01-01\n\nfirst content';
    await copyChangelogToPackages({ cwd: root, plan, changelog: firstRun });

    const secondRun = '## [1.1.0] - 2026-01-01\n\nsecond content (retry)';
    await copyChangelogToPackages({ cwd: root, plan, changelog: secondRun });

    const alphaContent = readFileSync(join(root, 'alpha', 'CHANGELOG.md'), 'utf-8');
    expect(alphaContent).toContain('second content (retry)');
    expect(alphaContent).not.toContain('first content');
    // Only one version-1.1.0 header, not two.
    expect(alphaContent.match(/## \[1\.1\.0\]/g)?.length).toBe(1);
  });

  it('preserves an older version section when a newer lockstep entry is prepended', async () => {
    const plan110: ReleasePlan = {
      packages: [makePkg({ name: '@scope/alpha', path: join(root, 'alpha'), nextVersion: '1.1.0' })],
      strategy: 'semver',
      registry: 'https://registry.npmjs.org',
      rollbackEnabled: true,
      channel: 'stable',
    };
    await copyChangelogToPackages({ cwd: root, plan: plan110, changelog: '## [1.1.0] - 2026-01-01\n\nfirst release' });

    const plan120: ReleasePlan = {
      packages: [
        makePkg({ name: '@scope/alpha', path: join(root, 'alpha'), currentVersion: '1.1.0', nextVersion: '1.2.0' }),
        makePkg({ name: '@scope/beta', path: join(root, 'beta'), currentVersion: '1.1.0', nextVersion: '1.2.0' }),
      ],
      strategy: 'semver',
      registry: 'https://registry.npmjs.org',
      rollbackEnabled: true,
      channel: 'stable',
    };
    await copyChangelogToPackages({ cwd: root, plan: plan120, changelog: '## [1.2.0] - 2026-02-01\n\nsecond release' });

    const alphaContent = readFileSync(join(root, 'alpha', 'CHANGELOG.md'), 'utf-8');
    expect(alphaContent).toContain('second release');
    expect(alphaContent).toContain('first release');
    expect(alphaContent.indexOf('1.2.0')).toBeLessThan(alphaContent.indexOf('1.1.0'));
  });
});

describe('mergeRootChangelog — repo-root .kb/release/CHANGELOG.md', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = join(tmpdir(), `kb-root-changelog-test-${randomBytes(4).toString('hex')}`);
    mkdirSync(join(repoRoot, 'alpha'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('prepends a new release on top of prior history instead of overwriting the file', async () => {
    const rootChangelogPath = join(repoRoot, '.kb', 'release', 'CHANGELOG.md');
    mkdirSync(join(repoRoot, '.kb', 'release'), { recursive: true });
    writeFileSync(rootChangelogPath, '## [1.0.0] - 2025-12-01\n\noriginal history\n', 'utf-8');

    const plan: ReleasePlan = {
      packages: [makePkg({ name: '@scope/alpha', path: join(repoRoot, 'alpha'), currentVersion: '1.0.0', nextVersion: '1.1.0' })],
      strategy: 'semver',
      registry: 'https://registry.npmjs.org',
      rollbackEnabled: true,
      channel: 'stable',
    };

    await mergeRootChangelog({ repoRoot, plan, changelog: '## [1.1.0] - 2026-01-01\n\nnew release content' });

    const content = readFileSync(rootChangelogPath, 'utf-8');
    expect(content).toContain('new release content');
    // Old history must survive — this is the exact bug: pipeline.ts used to
    // call writeFile() directly, discarding everything already in the file.
    expect(content).toContain('original history');
    expect(content.indexOf('1.1.0')).toBeLessThan(content.indexOf('1.0.0'));
  });

  it('does not repeat change bullets already present in root history', async () => {
    const rootChangelogPath = join(repoRoot, '.kb', 'release', 'CHANGELOG.md');
    mkdirSync(join(repoRoot, '.kb', 'release'), { recursive: true });
    writeFileSync(
      rootChangelogPath,
      '## [1.0.0] - 2025-12-01\n\n### Changes\n\n- **release**: shared change\n',
      'utf-8',
    );

    const plan: ReleasePlan = {
      packages: [makePkg({ name: '@scope/alpha', path: join(repoRoot, 'alpha'), currentVersion: '1.0.0', nextVersion: '1.1.0' })],
      strategy: 'semver',
      registry: 'https://registry.npmjs.org',
      rollbackEnabled: true,
      channel: 'stable',
    };

    await mergeRootChangelog({
      repoRoot,
      plan,
      changelog: '## [1.1.0] - 2026-01-01\n\n### Changes\n\n- **release**: shared change\n- **release**: unique change',
    });

    const content = readFileSync(rootChangelogPath, 'utf-8');
    expect(content.match(/\*\*release\*\*: shared change/g)?.length).toBe(1);
    expect(content.match(/\*\*release\*\*: unique change/g)?.length).toBe(1);
  });

  it('replaces the same-version section on retry instead of duplicating it', async () => {
    mkdirSync(join(repoRoot, 'beta'), { recursive: true });
    const plan: ReleasePlan = {
      packages: [
        makePkg({ name: '@scope/alpha', path: join(repoRoot, 'alpha'), nextVersion: '1.1.0' }),
        makePkg({ name: '@scope/beta', path: join(repoRoot, 'beta'), nextVersion: '1.1.0' }),
      ],
      strategy: 'semver',
      registry: 'https://registry.npmjs.org',
      rollbackEnabled: true,
      channel: 'stable',
    };

    await mergeRootChangelog({ repoRoot, plan, changelog: '## [1.1.0] - 2026-01-01\n\nfirst attempt' });
    await mergeRootChangelog({ repoRoot, plan, changelog: '## [1.1.0] - 2026-01-01\n\nretried attempt' });

    const content = readFileSync(join(repoRoot, '.kb', 'release', 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('retried attempt');
    expect(content).not.toContain('first attempt');
    expect(content.match(/## \[1\.1\.0\]/g)?.length).toBe(1);
  });

  it('creates the file and directory when neither exists yet', async () => {
    const plan: ReleasePlan = {
      packages: [makePkg({ name: '@scope/alpha', path: join(repoRoot, 'alpha'), nextVersion: '1.1.0' })],
      strategy: 'semver',
      registry: 'https://registry.npmjs.org',
      rollbackEnabled: true,
      channel: 'stable',
    };

    await mergeRootChangelog({ repoRoot, plan, changelog: '## [1.1.0] - 2026-01-01\n\nfirst-ever release' });

    const content = readFileSync(join(repoRoot, '.kb', 'release', 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('first-ever release');
  });

  it('writes to a config-driven outputPath instead of the default location', async () => {
    const plan: ReleasePlan = {
      packages: [makePkg({ name: '@scope/alpha', path: join(repoRoot, 'alpha'), nextVersion: '1.1.0' })],
      strategy: 'semver',
      registry: 'https://registry.npmjs.org',
      rollbackEnabled: true,
      channel: 'stable',
    };

    await mergeRootChangelog({
      repoRoot,
      plan,
      changelog: '## [1.1.0] - 2026-01-01\n\nroot-level release',
      outputPath: 'CHANGELOG.md',
    });

    expect(existsSync(join(repoRoot, '.kb', 'release', 'CHANGELOG.md'))).toBe(false);
    const content = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('root-level release');
  });
});
