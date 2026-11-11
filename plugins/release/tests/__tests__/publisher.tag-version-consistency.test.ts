import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { commitAndTagRelease } from '../../src/core/publisher';
import type { ReleasePlan } from '../../src/core/types';

// Reproduces the "tag says one version, package.json says another" incident:
// observed live as a real `sdk-v2.116.0` git tag pointing at a commit whose
// package.json actually said `2.115.0`. The tag name is built from
// plan.packages[*].nextVersion, but nothing ever confirmed that value still
// matches what the commit step actually wrote to disk — an idempotent-retry
// guard elsewhere in the pipeline can legitimately resolve nextVersion back
// to an already-published currentVersion on a retry, silently drifting the
// two apart. Untrustworthy tags are worse than a failed release: `deliver`
// resolves {flow, channel} FROM the tag and ships whatever's on disk under
// it, so a mismatched tag ships the wrong version with no error anywhere.

function makeRepo(): { root: string; remote: string } {
  const root = join(tmpdir(), `kb-tag-consistency-test-${randomBytes(4).toString('hex')}`);
  const remote = join(tmpdir(), `kb-tag-consistency-remote-${randomBytes(4).toString('hex')}.git`);
  mkdirSync(root, { recursive: true });

  execSync(`git init -q --bare "${remote}"`);
  execSync('git init -q', { cwd: root });
  execSync('git config user.email "test@test.com"', { cwd: root });
  execSync('git config user.name "Test"', { cwd: root });
  execSync(`git remote add origin "${remote}"`, { cwd: root });

  mkdirSync(join(root, 'alpha'), { recursive: true });
  writeFileSync(join(root, 'alpha', 'package.json'), JSON.stringify({ name: '@scope/alpha', version: '1.0.0' }));
  execSync('git add -A', { cwd: root });
  execSync('git commit -q -m "init"', { cwd: root });
  execSync('git push -q -u origin HEAD', { cwd: root });

  return { root, remote };
}

describe('commitAndTagRelease — tag/version consistency', () => {
  let root: string;
  let remote: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  it('refuses to tag when package.json on disk does not match plan.nextVersion', async () => {
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

    // Simulates the drift: the commit that's about to be staged has package.json
    // at a DIFFERENT version than what plan.nextVersion (and therefore the tag
    // name) claims — e.g. an idempotent-retry guard resolved it elsewhere.
    writeFileSync(join(root, 'alpha', 'package.json'), JSON.stringify({ name: '@scope/alpha', version: '1.2.0' }));

    await expect(commitAndTagRelease({ cwd: root, plan, flowName: 'platform' })).rejects.toThrow(
      /tag would say 1\.1\.0, package\.json says 1\.2\.0/,
    );

    // No tag was pushed with the wrong version attached.
    const remoteTags = execSync(`git ls-remote --tags "${remote}"`, { cwd: root }).toString();
    expect(remoteTags).not.toContain('platform-v1.1.0');
  });

  it('tags normally when package.json matches plan.nextVersion (no regression)', async () => {
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

    writeFileSync(join(root, 'alpha', 'package.json'), JSON.stringify({ name: '@scope/alpha', version: '1.1.0' }));

    const result = await commitAndTagRelease({ cwd: root, plan, flowName: 'platform' });

    expect(result.tagged).toEqual(['platform-v1.1.0']);
    const remoteTags = execSync(`git ls-remote --tags "${remote}"`, { cwd: root }).toString();
    expect(remoteTags).toContain('refs/tags/platform-v1.1.0');
  });
});
