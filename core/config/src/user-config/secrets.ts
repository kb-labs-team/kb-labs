/**
 * @module @kb-labs/core-config/user-config/secrets
 *
 * Secret handling rules for user config (ADR-0047: "secrets are references,
 * never values in the file"). A secret is stored as an environment reference
 * `${ENV_VAR}` (the syntax `interpolateConfig` resolves at load time).
 */

/** Same segment pattern `kb config show` uses to redact values. */
const SECRET_SEGMENT_PATTERN = /key|secret|token|password|passwd|jwt|credential/i;

/**
 * Segments that match the pattern but are not secrets (identifiers, names,
 * limits) so `set` does not demand a reference for them.
 */
const NON_SECRET_SEGMENTS = new Set([
  'keys',
  'keyprefix',
  'keyspace',
  'primarykey',
  'tokenlimit',
  'maxtokens',
  'maxtokenspermin',
  'tokenizer',
  'keyname',
]);

/** True when a dotted key path names a secret (any segment looks like a credential field). */
export function isSecretKeyPath(path: readonly string[]): boolean {
  return path.some((segment) => {
    const lower = segment.toLowerCase();
    return SECRET_SEGMENT_PATTERN.test(segment) && !NON_SECRET_SEGMENTS.has(lower);
  });
}

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Names of environment variables referenced by `${NAME}` placeholders in a string. */
export function envReferenceNames(value: string): string[] {
  return [...value.matchAll(ENV_REFERENCE)].map((match) => match[1]!);
}

/** True when the whole string is exactly one `${ENV_VAR}` reference. */
export function isEnvReference(value: unknown): boolean {
  return typeof value === 'string' && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim());
}

/** Well-known credential shapes. Deliberately conservative: false positives block legitimate writes. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^sk-[A-Za-z0-9_-]{16,}$/, // OpenAI / Anthropic style
  /^gh[pousr]_[A-Za-z0-9]{20,}$/, // GitHub tokens
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}$/, // Slack
  /^AKIA[0-9A-Z]{16}$/, // AWS access key id
  /^AIza[0-9A-Za-z_-]{30,}$/, // Google API key
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/, // JWT
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key
  /^[0-9]{8,10}:[A-Za-z0-9_-]{35}$/, // Telegram bot token
];

/** True when a string value has the shape of a well-known credential. */
export function looksLikeSecretValue(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Recursively collect string leaves of a value, each with its relative key path. */
function stringLeaves(value: unknown, prefix: string[], out: Array<{ path: string[]; value: string }>): void {
  if (typeof value === 'string') {
    out.push({ path: prefix, value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => stringLeaves(item, [...prefix, String(index)], out));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      stringLeaves(nested, [...prefix, key], out);
    }
  }
}

export interface PlainSecret {
  /** Full key path of the offending leaf. */
  path: string[];
  reason: 'secret-key' | 'secret-shape';
}

/**
 * Find raw secret values inside `value` being written at `basePath`.
 * A leaf is a plain secret when its key path is secret-declared or its value
 * looks like a credential, and it is not an `${ENV_VAR}` reference. Empty
 * strings are not secrets (they clear a value).
 */
export function findPlainSecrets(basePath: readonly string[], value: unknown): PlainSecret[] {
  const leaves: Array<{ path: string[]; value: string }> = [];
  stringLeaves(value, [...basePath], leaves);
  const found: PlainSecret[] = [];
  for (const leaf of leaves) {
    if (leaf.value.trim() === '' || envReferenceNames(leaf.value).length > 0) {
      continue;
    }
    if (isSecretKeyPath(leaf.path)) {
      found.push({ path: leaf.path, reason: 'secret-key' });
    } else if (looksLikeSecretValue(leaf.value)) {
      found.push({ path: leaf.path, reason: 'secret-shape' });
    }
  }
  return found;
}

export interface EnvReferenceLeaf {
  path: string[];
  variable: string;
}

/** References inside `value` written to secret-declared keys (these must resolve). */
export function findSecretReferences(basePath: readonly string[], value: unknown): EnvReferenceLeaf[] {
  const leaves: Array<{ path: string[]; value: string }> = [];
  stringLeaves(value, [...basePath], leaves);
  const found: EnvReferenceLeaf[] = [];
  for (const leaf of leaves) {
    if (!isSecretKeyPath(leaf.path)) {
      continue;
    }
    for (const variable of envReferenceNames(leaf.value)) {
      found.push({ path: leaf.path, variable });
    }
  }
  return found;
}
