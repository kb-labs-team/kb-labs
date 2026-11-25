export function workspaceSourceRefMismatch(
  requestedSourceRef: string | undefined,
  materializedSourceRef: unknown,
  requestedSourceCommit: string | undefined,
  materializedSourceCommit: unknown,
): Error | undefined {
  if (requestedSourceRef === undefined) {
    return undefined;
  }

  const validCommit = typeof materializedSourceCommit === 'string'
    && /^[a-f0-9]{40,64}$/.test(materializedSourceCommit);
  if (
    materializedSourceRef === requestedSourceRef
    && requestedSourceCommit !== undefined
    && validCommit
    && materializedSourceCommit === requestedSourceCommit
  ) return undefined;

  return Object.assign(
    new Error(
      `Requested source ref "${requestedSourceRef}" does not match the immutable source commit recorded for the existing workspace.`,
    ),
    { code: 'KB_WORKSPACE_PATCH_BASE_MISMATCH' },
  );
}
