import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { PackagePublisher, PublishablePackage, PublishResult, VerifyResult } from '../../src/core/types';

// Registry round-trip verification (npm pack against a real registry) is
// exercised in verdaccio-verify's own tests — here we only care that the
// pipeline calls it and reacts to its result, so stub it to always confirm.
vi.mock('../../src/core/verdaccio-verify.js', () => ({
  verifyAgainstRegistry: vi.fn(async (packages: PublishablePackage[]): Promise<VerifyResult[]> =>
    packages.map(p => ({ name: p.name, success: true, issues: [] }))),
}));

const { runReleasePipeline } = await import('../../src/core/pipeline.js');

const testShell = { async exec() { return { code: 0, stdout: '', stderr: '', ok: true }; } };

function makeTmpMonorepo(packages: Array<{ name: string; version?: string }>): { root: string; remote: string } {
  const root = join(tmpdir(), `kb-pipeline-channel-test-${randomBytes(4).toString('hex')}`);
  const remote = join(tmpdir(), `kb-pipeline-channel-remote-${randomBytes(4).toString('hex')}.git`);
  mkdirSync(root, { recursive: true });

  execSync(`git init -q --bare "${remote}"`);

  execSync('git init -q', { cwd: root });
  execSync('git config user.email "test@test.com"', { cwd: root });
  execSync('git config user.name "Test"', { cwd: root });
  execSync(`git remote add origin "${remote}"`, { cwd: root });
  writeFileSync(join(root, '.gitkeep'), '');
  execSync('git add .gitkeep', { cwd: root });
  execSync('git commit -q -m "init"', { cwd: root });

  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');

  for (const pkg of packages) {
    const dir = join(root, 'packages', pkg.name.replace(/^@[^/]+\//, ''));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version ?? '1.0.0' }));
  }

  execSync('git add -A', { cwd: root });
  execSync('git commit -q -m "add packages"', { cwd: root });
  execSync('git push -q -u origin HEAD', { cwd: root });

  return { root, remote };
}

function makePublisherSpy(): PackagePublisher & { calls: Array<{ packages: PublishablePackage[]; options: { dryRun?: boolean; access?: string; tag?: string; registry?: string } }> } {
  const calls: Array<{ packages: PublishablePackage[]; options: { dryRun?: boolean; access?: string; tag?: string; registry?: string } }> = [];
  return {
    calls,
    async publish(packages, options): Promise<PublishResult> {
      calls.push({ packages, options });
      return {
        published: packages.map(p => `${p.name}@${p.version}`),
        alreadyPublished: [],
        failed: [],
        skipped: [],
        errors: [],
      };
    },
  };
}

describe('runReleasePipeline — channel behavior', () => {
  let root: string;
  let remote: string;

  beforeEach(() => {
    ({ root, remote } = makeTmpMonorepo([{ name: '@scope/alpha' }]));
    process.env['NPM_TOKEN'] = 'test-token';
    // Stub the npm-auth pre-flight `whoami` check (and the registry-verify
    // isVersionPublished HEAD check) so the pipeline can proceed offline.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
    delete process.env['NPM_TOKEN'];
    vi.unstubAllGlobals();
  });

  it('stable: publishes with tag=latest, bumps package.json, and commits/tags git', async () => {
    const publisher = makePublisherSpy();
    const result = await runReleasePipeline({
      cwd: root,
      repoRoot: root,
      scopeCwd: root,
      shell: testShell,
      config: { bump: 'patch' },
      skipChecks: true,
      skipBuild: true,
      skipVerify: true,
      publisher,
    });

    expect(result.success).toBe(true);
    expect(result.plan.channel).toBe('stable');
    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]!.options.tag).toBe('latest');

    const pkgJson = JSON.parse(readFileSync(join(root, 'packages', 'alpha', 'package.json'), 'utf-8'));
    expect(pkgJson.version).toBe('1.0.1');

    // No --flow passed here, so the tag falls back to the "release" flow
    // name (see commitAndTagRelease's flowName default) — `release-v1.0.1`.
    const tags = execSync('git tag', { cwd: root }).toString();
    expect(tags).toContain('release-v1.0.1');
  });

  it('canary: publishes with tag=canary, never bumps package.json, and skips git entirely', async () => {
    const publisher = makePublisherSpy();
    const result = await runReleasePipeline({
      cwd: root,
      repoRoot: root,
      scopeCwd: root,
      shell: testShell,
      config: { bump: 'patch', channel: 'canary' },
      skipChecks: true,
      skipBuild: true,
      skipVerify: true,
      publisher,
    });

    expect(result.success).toBe(true);
    expect(result.plan.channel).toBe('canary');
    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]!.options.tag).toBe('canary');
    expect(publisher.calls[0]!.packages[0]!.version).toMatch(/^1\.0\.1-canary\.[0-9a-f]+$/);

    // package.json on disk is untouched — canary version only exists in-memory.
    const pkgJson = JSON.parse(readFileSync(join(root, 'packages', 'alpha', 'package.json'), 'utf-8'));
    expect(pkgJson.version).toBe('1.0.0');

    // No git tag was created for the canary version.
    const tags = execSync('git tag', { cwd: root }).toString();
    expect(tags).not.toContain('canary');

    // No CHANGELOG.md written either — canary skips changelog generation.
    expect(existsSync(join(root, 'packages', 'alpha', 'CHANGELOG.md'))).toBe(false);
  });

  it('skipPublish: never calls the publisher, but still bumps package.json and commits/tags git', async () => {
    const publisher = makePublisherSpy();
    // No npm token / whoami stub needed — skipPublish bypasses the pre-flight
    // entirely. Prove it by removing the stub this suite normally relies on.
    delete process.env['NPM_TOKEN'];
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network should not be reached in skipPublish mode')));

    const result = await runReleasePipeline({
      cwd: root,
      repoRoot: root,
      scopeCwd: root,
      shell: testShell,
      config: { bump: 'patch' },
      skipChecks: true,
      skipBuild: true,
      skipVerify: true,
      skipPublish: true,
      publisher,
    });

    expect(result.success).toBe(true);
    expect(publisher.calls).toHaveLength(0);

    const pkgJson = JSON.parse(readFileSync(join(root, 'packages', 'alpha', 'package.json'), 'utf-8'));
    expect(pkgJson.version).toBe('1.0.1');

    const tags = execSync('git tag', { cwd: root }).toString();
    expect(tags).toContain('release-v1.0.1');

    expect(result.report.result.published ?? []).toHaveLength(0);
    expect(result.report.result.skipped ?? []).toContain('@scope/alpha@1.0.1 (prepared, not published)');
  });
});
