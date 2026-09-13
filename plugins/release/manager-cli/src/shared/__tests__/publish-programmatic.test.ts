import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const capturedNpmrc: string[] = [];
const capturedArgs: string[][] = [];
// Tests can override these to simulate a failing `npm publish` — reset in beforeEach.
let mockCloseCode = 0;
let mockStderr = '';

vi.mock('node:child_process', () => ({
  spawn: vi.fn((_command: string, args: string[], options: { cwd: string }) => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    capturedArgs.push(args);

    // Capture the temp .npmrc content synchronously, before it's restored/removed.
    const npmrcPath = join(options.cwd, '.npmrc');
    try {
      capturedNpmrc.push(readFileSync(npmrcPath, 'utf-8'));
    } catch {
      capturedNpmrc.push('');
    }

    const closeCode = mockCloseCode;
    const stderr = mockStderr;
    queueMicrotask(() => {
      if (stderr) { child.stderr.emit('data', Buffer.from(stderr)); }
      child.emit('close', closeCode);
    });
    return child;
  }),
}));

import { publishPackagesProgrammatic } from '../publish-programmatic';

function makePackageDir(): string {
  const dir = join(tmpdir(), `publish-programmatic-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@kb-labs/fixture', version: '1.0.0' }));
  return dir;
}

describe('publishPackagesProgrammatic — .npmrc registry auth', () => {
  let pkgDir: string;

  beforeEach(() => {
    pkgDir = makePackageDir();
    capturedNpmrc.length = 0;
    capturedArgs.length = 0;
  });

  afterEach(() => {
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it('writes the auth token line scoped to the target registry, not registry.npmjs.org', async () => {
    await publishPackagesProgrammatic({
      packages: [{ name: '@kb-labs/fixture', version: '1.0.0', path: pkgDir }],
      registry: 'http://localhost:4873',
      token: 'verdaccio-token',
    });

    expect(capturedNpmrc).toHaveLength(1);
    expect(capturedNpmrc[0]).toContain('//localhost:4873/:_authToken=${NODE_AUTH_TOKEN}');
    expect(capturedNpmrc[0]).not.toContain('registry.npmjs.org');
  });

  it('defaults to registry.npmjs.org when no registry is passed', async () => {
    await publishPackagesProgrammatic({
      packages: [{ name: '@kb-labs/fixture', version: '1.0.0', path: pkgDir }],
      token: 'npm-token',
    });

    expect(capturedNpmrc).toHaveLength(1);
    expect(capturedNpmrc[0]).toContain('//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}');
  });
});

describe('publishPackagesProgrammatic — tarballPath (release deliver)', () => {
  let pkgDir: string;

  beforeEach(() => {
    pkgDir = makePackageDir();
    capturedNpmrc.length = 0;
    capturedArgs.length = 0;
  });

  afterEach(() => {
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it('publishes the tarball path directly instead of packing the directory fresh', async () => {
    const tarballPath = join(pkgDir, 'kb-labs-fixture-1.0.0.tgz');
    await publishPackagesProgrammatic({
      packages: [{ name: '@kb-labs/fixture', version: '1.0.0', path: pkgDir, tarballPath }],
      packageManager: 'npm',
      token: 'npm-token',
    });

    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0]).toEqual(['publish', tarballPath]);
  });

  it('omits --no-git-checks for a tarball publish even under pnpm — there is no working tree to check', async () => {
    const tarballPath = join(pkgDir, 'kb-labs-fixture-1.0.0.tgz');
    await publishPackagesProgrammatic({
      packages: [{ name: '@kb-labs/fixture', version: '1.0.0', path: pkgDir, tarballPath }],
      packageManager: 'pnpm',
      token: 'npm-token',
    });

    expect(capturedArgs[0]).not.toContain('--no-git-checks');
  });

  it('without tarballPath, still packs+publishes from the directory as before', async () => {
    await publishPackagesProgrammatic({
      packages: [{ name: '@kb-labs/fixture', version: '1.0.0', path: pkgDir }],
      packageManager: 'pnpm',
      token: 'npm-token',
    });

    expect(capturedArgs[0]).toEqual(['publish', '--no-git-checks']);
  });
});

describe('publishPackagesProgrammatic — permanent-failure diagnostics', () => {
  let pkgDir: string;

  beforeEach(() => {
    pkgDir = makePackageDir();
    capturedNpmrc.length = 0;
    capturedArgs.length = 0;
    mockCloseCode = 0;
    mockStderr = '';
  });

  afterEach(() => {
    rmSync(pkgDir, { recursive: true, force: true });
    mockCloseCode = 0;
    mockStderr = '';
  });

  it('extracts npm\'s own error code and attaches an actionable hint for a 403 (real-world case: npm-side package restriction, not a token problem)', async () => {
    mockCloseCode = 1;
    mockStderr = [
      'npm notice Publishing to https://registry.npmjs.org/ with tag latest and default access',
      'npm error code E403',
      'npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@kb-labs%2fadapters-fs',
      'npm error 403 In most cases, you or one of your dependencies are requesting',
      'npm error 403 a package version that is forbidden by your security policy, or',
      'npm error 403 on a server you do not have access to.',
    ].join('\n');

    const result = await publishPackagesProgrammatic({
      packages: [{ name: '@kb-labs/fixture', version: '1.0.0', path: pkgDir }],
      token: 'npm-token',
    });

    expect(result.results).toHaveLength(1);
    const [entry] = result.results;
    expect(entry!.success).toBe(false);
    expect(entry!.errorCode).toBe('E403');
    expect(entry!.errorHint).toMatch(/npm-side restriction/);
  });

  it('leaves errorCode/errorHint undefined for an unrecognized failure message', async () => {
    mockCloseCode = 1;
    mockStderr = 'some completely unrelated tool crash, no npm error code here';

    const result = await publishPackagesProgrammatic({
      packages: [{ name: '@kb-labs/fixture', version: '1.0.0', path: pkgDir }],
      token: 'npm-token',
    });

    const [entry] = result.results;
    expect(entry!.success).toBe(false);
    expect(entry!.errorCode).toBeUndefined();
    expect(entry!.errorHint).toBeUndefined();
  });

  it('treats a Verdaccio E409 conflict as already-published, not a permanent failure — a retry against the same commit must not fail Stage forever', async () => {
    // Verdaccio (the local staging registry release:stage-plan publishes
    // planned versions to) reports a version conflict with different
    // wording than npmjs.org's "cannot publish over the previously
    // published version" — real repro: re-running release-prepare's Stage
    // step at the same commit, against a registry it already staged to.
    mockCloseCode = 1;
    mockStderr = [
      'npm notice Publishing to http://localhost:4873/ with tag latest and public access',
      'npm error code E409',
      'npm error 409 Conflict - PUT http://localhost:4873/@kb-labs%2fadapters-analytics-duckdb - this package is already present',
    ].join('\n');

    const result = await publishPackagesProgrammatic({
      packages: [{ name: '@kb-labs/fixture', version: '1.0.0', path: pkgDir }],
      registry: 'http://localhost:4873',
      token: 'verdaccio-local',
    });

    const [entry] = result.results;
    expect(entry!.success).toBe(true);
    expect(entry!.alreadyPublished).toBe(true);
    expect(result.alreadyPublished).toEqual(['@kb-labs/fixture@1.0.0']);
    expect(result.failed).toEqual([]);
  });
});
