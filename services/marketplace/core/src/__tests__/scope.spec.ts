import { lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

    expect(resolveScopeRoot({ platformRoot }, { scope: 'project', projectRoot })).toBe(projectRoot);
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
    writeFileSync(join(platformRoot, '.kb', 'v2', 'receipt.json'), JSON.stringify({ installationId: 'install-a' }));
    symlinkSync(projectRoot, alias, 'dir');

    expect(() => resolveScopeRoot({ platformRoot }, { scope: 'project', projectRoot })).toThrow(/inside the managed platform installation/);
    expect(() => resolveScopeRoot({ platformRoot }, { scope: 'project', projectRoot: alias })).toThrow(/inside the managed platform installation/);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  });
});
