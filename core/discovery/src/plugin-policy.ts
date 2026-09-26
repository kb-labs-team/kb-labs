/**
 * @module @kb-labs/core-discovery/plugin-policy
 * Governance gate from `plugins.allow` / `plugins.block` / `plugins.linked`
 * in `<scopeRoot>/.kb/kb.config.json`.
 *
 * The gate applies to third-party (not `@kb-labs/*`) packages installed from the
 * marketplace (`node_modules` origin). First-party packages, linked and workspace
 * plugins are never gated by `allow`; `block` always wins for gated packages.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface PluginPolicy {
  /** When set, only these third-party packages (or linked ones) are discovered. */
  allow?: string[];
  /** Third-party packages that must never be discovered. */
  block?: string[];
  /** Names linked for local development: count as allowed. */
  linked?: string[];
}

export type PolicyVerdict = 'ok' | 'blocked' | 'not-allowed';

function names(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
}

/** Read the `plugins` section of `<root>/.kb/kb.config.json`. Missing or invalid file: no policy. */
export async function readPluginPolicy(root: string): Promise<PluginPolicy> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, '.kb', 'kb.config.json'), 'utf-8')) as {
      plugins?: { allow?: unknown; block?: unknown; linked?: unknown };
    };
    return {
      allow: names(raw.plugins?.allow),
      block: names(raw.plugins?.block),
      linked: names(raw.plugins?.linked),
    };
  } catch {
    return {};
  }
}

/** Decide whether a marketplace-installed package passes the gate. */
export function checkPluginPolicy(policy: PluginPolicy, ids: string[]): PolicyVerdict {
  if (ids.some(id => id.startsWith('@kb-labs/'))) {return 'ok';}
  if (policy.block?.some(b => ids.includes(b))) {return 'blocked';}
  if (policy.allow) {
    const permitted = ids.some(id => policy.allow?.includes(id) || policy.linked?.includes(id));
    if (!permitted) {return 'not-allowed';}
  }
  return 'ok';
}
