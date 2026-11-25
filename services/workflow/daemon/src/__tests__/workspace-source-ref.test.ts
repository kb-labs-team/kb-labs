import { describe, expect, it } from 'vitest';
import { workspaceSourceRefMismatch } from '../workspace-source-ref.js';

describe('workspaceSourceRefMismatch', () => {
  // case: S-325.2
  it('rejects a source ref that differs from the one recorded on an existing workspace', () => {
    expect(workspaceSourceRefMismatch('HEAD', 'main')).toMatchObject({
      code: 'KB_WORKSPACE_PATCH_BASE_MISMATCH',
      message: expect.stringContaining('HEAD'),
    });
    expect(workspaceSourceRefMismatch('HEAD', undefined)).toMatchObject({
      code: 'KB_WORKSPACE_PATCH_BASE_MISMATCH',
    });
  });

  it('does not require a source ref when the workflow inherits an existing workspace', () => {
    expect(workspaceSourceRefMismatch(undefined, 'main')).toBeUndefined();
  });
});
