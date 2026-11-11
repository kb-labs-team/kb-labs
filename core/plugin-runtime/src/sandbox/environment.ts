import type { PermissionSpec } from '@kb-labs/plugin-contracts';

/** Return only environment entries granted by `permissions.env.read`. */
export function selectPermittedEnvironment(
  permissions: PermissionSpec,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const pattern of permissions.env?.read ?? []) {
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      for (const [key, value] of Object.entries(environment)) {
        if (key.startsWith(prefix) && value !== undefined) {selected[key] = value;}
      }
    } else {
      const value = environment[pattern];
      if (value !== undefined) {selected[pattern] = value;}
    }
  }
  return selected;
}
