import { describe, expect, it } from 'vitest';
import { workspaceSourceRefMismatch } from '../workspace-source-ref.js';

describe('workspaceSourceRefMismatch', () => {
  // case: S-325.2
  it('rejects a source ref that differs from the one recorded on an existing workspace', () => {
    expect(workspaceSourceRefMismatch('HEAD', 'main', 'a'.repeat(40), 'a'.repeat(40))).toMatchObject({
      code: 'KB_WORKSPACE_PATCH_BASE_MISMATCH',
      message: expect.stringContaining('HEAD'),
    });
    expect(workspaceSourceRefMismatch('HEAD', undefined, 'a'.repeat(40), undefined)).toMatchObject({
      code: 'KB_WORKSPACE_PATCH_BASE_MISMATCH',
    });
  });

  it('does not require a source ref when the workflow inherits an existing workspace', () => {
    expect(workspaceSourceRefMismatch(undefined, 'main', undefined, undefined)).toBeUndefined();
  });

  it('rejects a symbolic ref that now resolves to a different immutable commit', () => {
    expect(workspaceSourceRefMismatch('HEAD', 'HEAD', 'b'.repeat(40), 'a'.repeat(40))).toMatchObject({
      code: 'KB_WORKSPACE_PATCH_BASE_MISMATCH',
    });
  });

  it('rejects legacy symbolic metadata without a recorded immutable commit', () => {
    expect(workspaceSourceRefMismatch('HEAD', 'HEAD', 'a'.repeat(40), undefined)).toMatchObject({
      code: 'KB_WORKSPACE_PATCH_BASE_MISMATCH',
    });
  });
});
