/**
 * @module @kb-labs/cli-contracts/reserved-namespaces
 *
 * Single source of truth for reserved CLI command namespaces
 * (docs/architecture/target/06-command-naming.md §8).
 *
 * Tiers:
 * - S  system: only the CLI core may own the name
 * - V  top-level verbs: kept free for future `kb <verb>` commands, nobody owns them
 * - F  first-party: only packages from the `@kb-labs/*` scope may own the name
 * - R  future entities: reserved for planned platform concepts, nobody owns them
 * - P  platform-private: any name starting with `_` (e.g. `__complete`, `__internal`)
 *
 * Adding a name to S/V/R is a breaking change for plugin authors: check it
 * against the known-plugin registry first, and review R every release.
 * Zero runtime dependencies.
 */

/** S: system namespaces. Verified against cli/commands/src/utils/register.ts and commands/system. */
export const SYSTEM_NAMESPACES = [
  // Registered today: groups + standalone commands
  'info', 'docs', 'registry', 'logs', 'auth', 'platform', 'webhook', 'config',
  'completion', 'diag',
  // Command names/aliases living inside the `info` group
  'hello', 'version', 'health',
  // Planned system namespaces (06 §8)
  'help', 'project', 'plugin', 'adapter',
] as const;

/** V: top-level verbs kept free for future `kb <verb>`. */
export const VERB_NAMESPACES = [
  'init', 'start', 'stop', 'restart', 'status', 'update', 'upgrade', 'install',
  'uninstall', 'doctor', 'login', 'logout', 'open', 'sync', 'run', 'debug',
  'test', 'build',
] as const;

/** F: first-party names, allowed only for packages in the `@kb-labs/*` scope. */
export const FIRST_PARTY_NAMESPACES = [
  'commit', 'mind', 'agent', 'review', 'qa', 'quality', 'release', 'workflow',
  'marketplace', 'state', 'gateway', 'inbox', 'steward', 'policy', 'impact',
  'devlink', 'scaffold', 'github', 'clickup',
] as const;

/** R: reserved for planned future entities. */
export const FUTURE_NAMESPACES = [
  'user', 'team', 'tenant', 'token', 'secret', 'env', 'skill', 'template',
  'profile', 'deploy', 'dev', 'devkit', 'monitor', 'support', 'assistant',
] as const;

export type ReservedTier = 'S' | 'V' | 'F' | 'R' | 'P';

export const RESERVED_NAMESPACES = {
  S: SYSTEM_NAMESPACES,
  V: VERB_NAMESPACES,
  F: FIRST_PARTY_NAMESPACES,
  R: FUTURE_NAMESPACES,
} as const;

/** Scope whose packages may own tier-F names. */
export const FIRST_PARTY_SCOPE = '@kb-labs/';

export interface ReservedNamespaceViolation {
  tier: ReservedTier;
  namespace: string;
  /** Human-readable, self-contained message including the suggested alternative. */
  message: string;
  /** Suggested replacement namespace, e.g. `acme-user`. Empty for tier P. */
  suggestion: string;
}

const TIER_LABEL: Record<ReservedTier, string> = {
  S: 'used by a KB Labs system command',
  V: 'reserved for future top-level commands',
  F: 'reserved for first-party (@kb-labs/*) plugins',
  R: 'reserved for a planned platform entity',
  P: 'reserved by the platform (names starting with "_")',
};

function tierOf(namespace: string): Exclude<ReservedTier, 'P'> | null {
  const tiers = ['S', 'V', 'F', 'R'] as const;
  for (const tier of tiers) {
    if ((RESERVED_NAMESPACES[tier] as readonly string[]).includes(namespace)) {
      return tier;
    }
  }
  return null;
}

function toKebab(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Suggest a non-reserved replacement: `<org>-<namespace>`, where org comes from the
 * package scope (`@acme/x` -> `acme`), else the package name, else `my`.
 */
export function suggestNamespace(namespace: string, packageName?: string): string {
  let org = '';
  if (packageName && packageName !== 'unknown') {
    const scoped = /^@([^/]+)\//.exec(packageName);
    org = toKebab(scoped ? scoped[1]! : packageName);
  }
  if (!org || org === 'kb-labs' || org === toKebab(namespace)) {
    org = 'my';
  }
  return `${org}-${namespace.replace(/^_+/, '')}`;
}

/**
 * Check whether `packageName` may own the top-level command namespace `namespace`.
 * Returns null when allowed, otherwise a violation with a message and suggestion.
 *
 * Tier F is allowed only for packages whose name starts with `@kb-labs/`.
 */
export function checkReservedNamespace(
  namespace: string,
  packageName?: string,
): ReservedNamespaceViolation | null {
  let tier: ReservedTier | null = namespace.startsWith('_') ? 'P' : tierOf(namespace);
  if (tier === 'F' && packageName?.startsWith(FIRST_PARTY_SCOPE)) {
    tier = null;
  }
  if (!tier) {
    return null;
  }
  const suggestion = tier === 'P' ? '' : suggestNamespace(namespace, packageName);
  const hint = suggestion ? `; try "${suggestion}"` : '';
  return {
    tier,
    namespace,
    suggestion,
    message: `Namespace "${namespace}" is ${TIER_LABEL[tier]} (tier ${tier})${hint}`,
  };
}

/** Flat list of all reserved names (S, V, F, R). */
export function listReservedNamespaces(): string[] {
  return [
    ...RESERVED_NAMESPACES.S,
    ...RESERVED_NAMESPACES.V,
    ...RESERVED_NAMESPACES.F,
    ...RESERVED_NAMESPACES.R,
  ];
}
