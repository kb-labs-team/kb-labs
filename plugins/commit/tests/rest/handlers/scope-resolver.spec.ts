import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveScopePath } from '../../../src/rest/handlers/scope-resolver';

describe('resolveScopePath', () => {
  const baseCwd = '/Users/test/kb-labs';

  it('returns base directory for root-like scopes', () => {
    expect(resolveScopePath(baseCwd, 'root')).toBe(baseCwd);
    expect(resolveScopePath(baseCwd, '.')).toBe(baseCwd);
    expect(resolveScopePath(baseCwd)).toBe(baseCwd);
  });

  it('joins scope path from id when no scopes config provided', () => {
    const scope = 'kb-labs-mind/packages/mind-cli';
    const resolved = resolveScopePath(baseCwd, scope);
    expect(resolved).toBe(join(baseCwd, scope));
  });

  it('resolves scope path from scopes config when id matches', () => {
    const scopes = [{ id: 'mind', label: 'Mind', path: 'plugins/kb-labs-mind' }];
    const resolved = resolveScopePath(baseCwd, 'mind', scopes);
    expect(resolved).toBe(join(baseCwd, 'plugins/kb-labs-mind'));
  });

  it('falls back to id as path when scope not found in config', () => {
    const scopes = [{ id: 'mind', label: 'Mind', path: 'plugins/kb-labs-mind' }];
    const resolved = resolveScopePath(baseCwd, 'other-scope', scopes);
    expect(resolved).toBe(join(baseCwd, 'other-scope'));
  });
});
