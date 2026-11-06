import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
});
