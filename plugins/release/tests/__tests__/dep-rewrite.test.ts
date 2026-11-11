import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { rewriteWorkspaceDeps } from '../../src/shared/dep-rewrite';

function makeRoot(): string {
  const root = join(tmpdir(), `dep-rewrite-cli-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writePkg(dir: string, content: object): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(content, null, 2));
}

describe('rewriteWorkspaceDeps — own version', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('overwrites the on-disk version with the target publish version (the canary bug)', () => {
    writePkg(root, { name: '@scope/alpha', version: '1.0.0' });

    const restore = rewriteWorkspaceDeps(
      { path: root, version: '1.1.0-canary.abc1234' },
      new Map([['@scope/alpha', '1.1.0-canary.abc1234']]),
      'pnpm',
    );

    const written = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    expect(written.version).toBe('1.1.0-canary.abc1234');

    restore();
    const restored = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    expect(restored.version).toBe('1.0.0');
  });

  it('is a no-op for the version field when on-disk version already matches (stable path)', () => {
    writePkg(root, { name: '@scope/alpha', version: '1.1.0' });
    const original = readFileSync(join(root, 'package.json'), 'utf-8');

    const restore = rewriteWorkspaceDeps(
      { path: root, version: '1.1.0' },
      new Map([['@scope/alpha', '1.1.0']]),
      'pnpm',
    );

    // No modification needed → file untouched (still readable/equal), restore is safe no-op.
    expect(readFileSync(join(root, 'package.json'), 'utf-8')).toBe(original);
    restore();
    expect(readFileSync(join(root, 'package.json'), 'utf-8')).toBe(original);
  });

  it('still rewrites workspace:/link: deps for non-pnpm package managers alongside the version bump', () => {
    writePkg(root, {
      name: '@scope/alpha',
      version: '1.0.0',
      dependencies: { '@scope/beta': 'workspace:*' },
    });

    const restore = rewriteWorkspaceDeps(
      { path: root, version: '1.1.0-canary.abc1234' },
      new Map([['@scope/alpha', '1.1.0-canary.abc1234'], ['@scope/beta', '2.0.0']]),
      'npm',
    );

    const written = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    expect(written.version).toBe('1.1.0-canary.abc1234');
    expect(written.dependencies['@scope/beta']).toBe('^2.0.0');

    restore();
  });

  it('preserves caret and tilde ranges when materializing workspace protocols', () => {
    writePkg(root, {
      name: '@scope/alpha',
      version: '1.0.0',
      dependencies: {
        '@scope/beta': 'workspace:^',
        '@scope/gamma': 'workspace:~',
      },
      optionalDependencies: { '@scope/optional': 'workspace:*' },
    });

    const restore = rewriteWorkspaceDeps(
      { path: root, version: '1.0.0' },
      new Map([
        ['@scope/alpha', '1.0.0'],
        ['@scope/beta', '2.0.0'],
        ['@scope/gamma', '3.0.0'],
        ['@scope/optional', '4.0.0'],
      ]),
      'npm',
    );

    const written = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    expect(written.dependencies['@scope/beta']).toBe('^2.0.0');
    expect(written.dependencies['@scope/gamma']).toBe('~3.0.0');
    expect(written.optionalDependencies['@scope/optional']).toBe('^4.0.0');

    restore();
  });

  it('leaves workspace:* deps untouched for pnpm (pnpm handles them natively) while still bumping version', () => {
    writePkg(root, {
      name: '@scope/alpha',
      version: '1.0.0',
      dependencies: { '@scope/beta': 'workspace:*' },
    });

    const restore = rewriteWorkspaceDeps(
      { path: root, version: '1.1.0-canary.abc1234' },
      new Map([['@scope/alpha', '1.1.0-canary.abc1234'], ['@scope/beta', '2.0.0']]),
      'pnpm',
    );

    const written = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    expect(written.version).toBe('1.1.0-canary.abc1234');
    expect(written.dependencies['@scope/beta']).toBe('workspace:*');

    restore();
  });

  // Reproduces the "EUNSUPPORTEDPROTOCOL crashes an unrelated consumer's
  // install" bug: devDependencies was never in the rewritten section list, so
  // a published tarball could ship a literal "workspace:*" in its
  // devDependencies. That field is never installed for a *dependency*
  // package, but npm's own manifest validation (@npmcli/arborist, via
  // npm-package-arg) parses every dependency-like section of every manifest
  // it reads while building the ideal tree — including devDependencies many
  // levels deep in someone else's graph — and throws EUNSUPPORTEDPROTOCOL,
  // aborting the whole install. Confirmed live on
  // @kb-labs/plugin-execution-factory@2.114.0's
  // devDependencies.@kb-labs/gateway-core.
  it('rewrites devDependencies workspace:* refs for non-pnpm package managers', () => {
    writePkg(root, {
      name: '@scope/alpha',
      version: '1.0.0',
      devDependencies: { '@scope/gamma': 'workspace:*' },
    });

    const restore = rewriteWorkspaceDeps(
      { path: root, version: '1.0.0' },
      new Map([['@scope/alpha', '1.0.0'], ['@scope/gamma', '2.0.0']]),
      'npm',
    );

    const written = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    expect(written.devDependencies['@scope/gamma']).toBe('^2.0.0');

    restore();
  });

});
