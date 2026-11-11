import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { commitAndTagRelease } from '../../src/core/publisher';
import type { ReleasePlan } from '../../src/core/types';

function makeRepoWithManyExistingTags(existingTagCount: number): { root: string; remote: string } {
  const root = join(tmpdir(), `kb-git-push-test-${randomBytes(4).toString('hex')}`);
  const remote = join(tmpdir(), `kb-git-push-remote-${randomBytes(4).toString('hex')}.git`);
  mkdirSync(root, { recursive: true });

  execSync(`git init -q --bare "${remote}"`);
  execSync('git init -q', { cwd: root });
  execSync('git config user.email "test@test.com"', { cwd: root });
  execSync('git config user.name "Test"', { cwd: root });
  execSync(`git remote add origin "${remote}"`, { cwd: root });

  writeFileSync(join(root, '.gitkeep'), '');
  execSync('git add .gitkeep', { cwd: root });
  execSync('git commit -q -m "init"', { cwd: root });

  mkdirSync(join(root, 'alpha'), { recursive: true });
  writeFileSync(join(root, 'alpha', 'package.json'), JSON.stringify({ name: '@scope/alpha', version: '1.0.0' }));
  execSync('git add -A', { cwd: root });
  execSync('git commit -q -m "add package"', { cwd: root });
  execSync('git push -q -u origin HEAD', { cwd: root });

  // Simulate a repo with a long release history: many pre-existing tags
  // already on the remote, matching the real v2.x.0 tag pattern that broke
  // the old `git push --tags` behavior. Tag on the FIRST commit and push,
  // then advance the local branch — so these tags stay fixed on the remote
  // while local history moves on, exactly like a real repo's old release
  // tags sitting on long-past commits.
  const firstCommit = execSync('git rev-parse HEAD~1', { cwd: root }).toString().trim();
  for (let i = 1; i <= existingTagCount; i++) {
    execSync(`git tag v1.${i}.0 ${firstCommit}`, { cwd: root });
  }
  execSync('git push -q origin --tags', { cwd: root });

  // Force one of those "old" tags to diverge locally from what's already on
  // the remote (name matches, target commit doesn't) — this is what actually
  // triggers `[rejected] (already exists)`: a real name collision, not mere
  // redundancy. A synthetic repo with byte-identical local/remote tags never
  // reproduces the bug, since `git push --tags` no-ops on tags that already
  // match.
  const secondCommit = execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
  execSync(`git tag -f v1.1.0 ${secondCommit}`, { cwd: root });

  return { root, remote };
}

describe('commitAndTagRelease — tag push with pre-existing remote tags', () => {
  let root: string;
  let remote: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  it('succeeds and pushes only the new tag, even with dozens of pre-existing remote tags', async () => {
    ({ root, remote } = makeRepoWithManyExistingTags(30));

    const plan: ReleasePlan = {
      packages: [
        { name: '@scope/alpha', path: join(root, 'alpha'), gitRoot: root, currentVersion: '1.0.0', nextVersion: '1.1.0', bump: 'minor', isPublished: false },
      ],
      strategy: 'semver',
      registry: 'https://registry.npmjs.org',
      rollbackEnabled: true,
      channel: 'stable',
    };

    writeFileSync(join(root, 'alpha', 'package.json'), JSON.stringify({ name: '@scope/alpha', version: '1.1.0' }));

    const result = await commitAndTagRelease({ cwd: root, plan });

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    // No flowName passed — falls back to the "release" flow name, one
    // flow-level tag `{flow}-v{version}` (see tag.ts / commitAndTagRelease).
    expect(result.tagged).toEqual(['release-v1.1.0']);

    // The new tag actually landed on the remote.
    const remoteTags = execSync(`git ls-remote --tags "${remote}"`, { cwd: root }).toString();
    expect(remoteTags).toContain('refs/tags/release-v1.1.0');
  });
});
