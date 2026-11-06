import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { commitAndTagRelease, mergeRootChangelog } from '../../src/core/publisher';
import type { ReleasePlan } from '../../src/core/types';

function makeRepo(): { root: string; remote: string } {
  const root = join(tmpdir(), `kb-changelog-path-test-${randomBytes(4).toString('hex')}`);
  const remote = join(tmpdir(), `kb-changelog-path-remote-${randomBytes(4).toString('hex')}.git`);
  mkdirSync(root, { recursive: true });

  execSync(`git init -q --bare "${remote}"`);
  execSync('git init -q', { cwd: root });
  execSync('git config user.email "test@test.com"', { cwd: root });
  execSync('git config user.name "Test"', { cwd: root });
  execSync(`git remote add origin "${remote}"`, { cwd: root });

  mkdirSync(join(root, 'alpha'), { recursive: true });
  writeFileSync(join(root, 'alpha', 'package.json'), JSON.stringify({ name: '@scope/alpha', version: '1.1.0' }));
  execSync('git add -A', { cwd: root });
  execSync('git commit -q -m "init"', { cwd: root });
  execSync('git push -q -u origin HEAD', { cwd: root });

  return { root, remote };
}

describe('commitAndTagRelease — config-driven root changelog path', () => {
  let root: string;
  let remote: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  it('stages the changelog at the configured outputPath, not the default', async () => {
    ({ root, remote } = makeRepo());

    const plan: ReleasePlan = {
      packages: [
        { name: '@scope/alpha', path: join(root, 'alpha'), gitRoot: root, currentVersion: '1.0.0', nextVersion: '1.1.0', bump: 'minor', isPublished: false },
      ],
      strategy: 'semver',
      registry: 'https://registry.npmjs.org',
      rollbackEnabled: true,
      channel: 'stable',
    };

    await mergeRootChangelog({
      repoRoot: root,
      plan,
      changelog: '## [1.1.0] - 2026-01-01\n\nconfigured path release',
      outputPath: 'CHANGELOG.md',
    });

    const result = await commitAndTagRelease({
      cwd: root,
      plan,
      repoRoot: root,
      changelogOutputPath: 'CHANGELOG.md',
    });

    expect(result.committed).toBe(true);

    const committedFiles = execSync('git show --stat --name-only HEAD', { cwd: root }).toString();
    expect(committedFiles).toContain('CHANGELOG.md');
    expect(committedFiles).not.toContain('.kb/release/CHANGELOG.md');
  });
});
