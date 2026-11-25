import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDevkitBin } from '../../src/core/devkit/devkit-discovery.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });}
});

describe('resolveDevkitBin', () => {
  // case: S-326.2
  it('uses the owning project tool when an isolated worktree omits ignored outputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'qa-devkit-discovery-'));
    roots.push(root);
    const workspace = join(root, 'worktree');
    const project = join(root, 'project');
    const tool = join(project, 'tools', 'kb-devkit', 'kb-devkit');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(project, 'tools', 'kb-devkit'), { recursive: true });
    writeFileSync(tool, '');

    expect(resolveDevkitBin(workspace, undefined, project)).toBe(tool);
  });
});
