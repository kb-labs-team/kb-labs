import { PluginError } from '@kb-labs/sdk';

interface ViewerSchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } };
}

export function parseViewerInput<T>(schema: ViewerSchema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new PluginError(
      'The Viewer request contains invalid input.',
      'KB_RUNTIME_INPUT_INVALID',
      { field: result.error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ') },
    );
  }
  return result.data;
}
