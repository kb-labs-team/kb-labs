import { registerProcessSensitiveValues } from '@kb-labs/core-platform';

export interface CommandFlagValueDeclaration {
  name: string;
  secret?: boolean;
}

/** Register parsed secret-typed command inputs before command dispatch. */
export function registerSecretFlagValues(
  declarations: readonly CommandFlagValueDeclaration[],
  values: Readonly<Record<string, unknown>>,
): void {
  const secretNames = declarations.filter(({ secret }) => secret === true).map(({ name }) => name);
  registerProcessSensitiveValues(secretNames.flatMap((name) => {
    const value = values[name];
    if (typeof value === 'string') {return [value];}
    if (Array.isArray(value)) {return value.filter((entry): entry is string => typeof entry === 'string');}
    return [];
  }));
}
