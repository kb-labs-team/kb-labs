import { describe, expect, it } from 'vitest';
import { resolveSubAgentToolPolicy } from '../src/subagent-tool-policy.js';

describe('shared sub-agent tool policy', () => {
  it('resolves each preset to canonical capabilities and KB tool IDs', () => {
    expect(resolveSubAgentToolPolicy('research')).toMatchObject({
      maxIterations: 50,
      allowedToolIds: expect.arrayContaining(['fs_read', 'grep_search', 'memory_get', 'archive_recall', 'report']),
    });
    expect(resolveSubAgentToolPolicy('research')?.allowedToolIds).not.toContain('fs_write');
    expect(resolveSubAgentToolPolicy('execute')?.allowedToolIds).toContain('fs_write');
    expect(resolveSubAgentToolPolicy('execute')?.allowedToolIds).not.toContain('archive_recall');
    expect(resolveSubAgentToolPolicy('review')?.allowedToolIds).toContain('shell_exec');
    expect(resolveSubAgentToolPolicy('review')?.allowedToolIds).not.toContain('fs_patch');
  });

  it('returns no policy for unknown preset identifiers', () => {
    expect(resolveSubAgentToolPolicy('unknown')).toBeUndefined();
  });
});
