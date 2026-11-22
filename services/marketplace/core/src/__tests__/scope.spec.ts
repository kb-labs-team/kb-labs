import { lstatSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveScopeRoot } from '../scope.js';

let sandbox: string;

afterEach(() => {
  if (sandbox) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

describe('marketplace project scope', () => {
  // case: S-204.3
  it('accepts a project root without requiring repository .kb files', () => {
    sandbox = mkdtempSync(join(tmpdir(), 'kb-marketplace-scope-'));
    const platformRoot = join(sandbox, 'platform');
    const projectRoot = join(sandbox, 'registered-project');
    mkdirSync(platformRoot);
    mkdirSync(projectRoot);

    expect(resolveScopeRoot({ platformRoot }, { scope: 'project', projectRoot })).toBe(realpathSync(projectRoot));
  });

  // case: S-269.11
  it('rejects project roots inside a managed platform install, including symlink aliases', () => {
    sandbox = mkdtempSync(join(tmpdir(), 'kb-marketplace-managed-scope-'));
    const installRoot = join(sandbox, 'install');
    const platformRoot = join(installRoot, 'versions', '1.0.0');
    const projectRoot = join(installRoot, 'projects', 'project-a');
    const alias = join(sandbox, 'project-alias');
    mkdirSync(join(platformRoot, '.kb', 'v2'), { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    symlinkSync(join('versions', '1.0.0'), join(installRoot, 'current'), 'dir');
    writeFileSync(join(platformRoot, '.kb', 'v2', 'receipt.json'), JSON.stringify({ installationId: 'install-a' }));
    symlinkSync(projectRoot, alias, 'dir');

    expect(() => resolveScopeRoot({ platformRoot }, { scope: 'project', projectRoot })).toThrow(/inside the managed platform installation/);
    expect(() => resolveScopeRoot({ platformRoot }, { scope: 'project', projectRoot: alias })).toThrow(/inside the managed platform installation/);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  });

  // case: S-269.11
  it('rejects project write targets that alias managed metadata or package graph through symlinks', () => {
    sandbox = mkdtempSync(join(tmpdir(), 'kb-marketplace-managed-target-'));
    const installRoot = join(sandbox, 'install');
    const platformRoot = join(installRoot, 'versions', '1.0.0');
    const projectRoot = join(sandbox, 'project');
    mkdirSync(join(platformRoot, '.kb'), { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    symlinkSync(join('versions', '1.0.0'), join(installRoot, 'current'), 'dir');

    symlinkSync(join(platformRoot, '.kb'), join(projectRoot, '.kb'), 'dir');
    expect(() => resolveScopeRoot({ platformRoot }, { scope: 'project', projectRoot })).toThrow(/managed platform installation/);

    rmSync(join(projectRoot, '.kb'));
    mkdirSync(join(projectRoot, '.kb'));
    const platformLock = join(platformRoot, '.kb', 'marketplace.lock');
    writeFileSync(platformLock, '{}');
    symlinkSync(platformLock, join(projectRoot, '.kb', 'marketplace.lock'), 'file');
    expect(() => resolveScopeRoot({ platformRoot }, { scope: 'project', projectRoot })).toThrow(/managed platform installation/);

    rmSync(join(projectRoot, '.kb'), { recursive: true });
    symlinkSync(join(platformRoot, '.kb', 'missing'), join(projectRoot, '.kb'), 'dir');
    expect(() => resolveScopeRoot({ platformRoot }, { scope: 'project', projectRoot })).toThrow(/Cannot safely resolve project write target/);

    rmSync(join(projectRoot, '.kb'));
    symlinkSync(platformRoot, join(projectRoot, 'node_modules'), 'dir');
    expect(() => resolveScopeRoot({ platformRoot }, { scope: 'project', projectRoot })).toThrow(/managed platform installation/);

    rmSync(join(projectRoot, 'node_modules'));
    const dotNameInsideInstall = join(installRoot, '..draft');
    mkdirSync(dotNameInsideInstall);
    expect(() => resolveScopeRoot({ platformRoot }, { scope: 'project', projectRoot: dotNameInsideInstall })).toThrow(/managed platform installation/);
  });
});
