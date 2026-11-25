export function workspaceSourceRefMismatch(
  requestedSourceRef: string | undefined,
  materializedSourceRef: unknown,
): Error | undefined {
  if (requestedSourceRef === undefined || materializedSourceRef === requestedSourceRef) {
    return undefined;
  }

  return Object.assign(
    new Error(
      `Requested source ref "${requestedSourceRef}" does not match the source ref recorded for the existing workspace.`,
    ),
    { code: 'KB_WORKSPACE_PATCH_BASE_MISMATCH' },
  );
}
