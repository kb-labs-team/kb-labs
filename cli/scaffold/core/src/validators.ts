const NAME_RE = /^[a-z][a-z0-9-]*$/;
const SCOPE_RE = /^@[a-z][a-z0-9-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const RESERVED_NAMES = new Set([
  'kb',
  'core',
  'sdk',
  'test',
  'tests',
  'node_modules',
  'dist',
  'src',
  'con',
  'prn',
  'nul',
]);

export function validatePackageName(name: string): string | null {
  if (!name) {return 'name is required';}
  if (name.length > 214) {return 'name must be <= 214 chars';}
  if (!NAME_RE.test(name)) {
    return 'name must be lowercase, start with a letter, and contain only a-z 0-9 -';
  }
  if (RESERVED_NAMES.has(name)) {return `name "${name}" is reserved`;}
  return null;
}

export function validateScope(scope: string): string | null {
  if (!scope) {return null;}
  if (!SCOPE_RE.test(scope)) {
    return 'scope must look like "@acme" (lowercase, starts with @, a-z 0-9 -)';
  }
  return null;
}

export function validateSemver(v: string): string | null {
  return SEMVER_RE.test(v) ? null : 'expected semver (e.g. 1.2.3)';
}

export function validateIdentifier(v: string): string | null {
  return IDENTIFIER_RE.test(v) ? null : 'expected a JS identifier';
}

export function runValidator(
  kind: string,
  value: unknown,
): string | null {
  if (typeof value !== 'string') {return 'expected a string';}
  switch (kind) {
    case 'npmName':
      return validatePackageName(value);
    case 'npmScope':
      return validateScope(value);
    case 'semver':
      return validateSemver(value);
    case 'identifier':
      return validateIdentifier(value);
    default:
      return null;
  }
}
