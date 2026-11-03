/** Governance gate from plugins.allow / plugins.block / plugins.linked. */

import { readJsonWithDiagnostics, resolveUserConfigFile } from '@kb-labs/core-config';
import type { Diagnostic } from '@kb-labs/core-config';
import { fs, readFile } from './recording-filesystem.js';

export interface PluginPolicy {
  allow?: string[];
  block?: string[];
  linked?: string[];
}

export type PolicyVerdict = 'ok' | 'blocked' | 'not-allowed';
export interface PluginProvenance {
  origin: 'workspace' | 'linked' | 'node_modules';
  scope: 'platform' | 'project';
  lockSource?: 'marketplace' | 'platform' | 'local';
}
export type PluginPolicyResult =
  | { kind: 'valid'; policy: PluginPolicy }
  | { kind: 'invalid'; configPath: string; diagnostics: Diagnostic[] };

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function diagnostic(code: string, message: string, configPath: string, detail?: unknown): Diagnostic {
  return { level: 'error', code, message, path: configPath, detail,
    hint: `Repair the plugin policy in "${configPath}" before retrying discovery.` };
}

/** First-party status comes from discovery provenance, never npm package naming. */
export function isFirstPartyPluginSource(source: PluginProvenance): boolean {
  return source.origin !== 'node_modules' || (source.scope === 'platform' && source.lockSource === 'platform');
}

function readNames(value: unknown, field: 'allow' | 'block' | 'linked', configPath: string, diagnostics: Diagnostic[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic('PLUGIN_POLICY_TYPE_INVALID', `plugins.${field} must be an array of package names`, configPath, { field: `$.plugins.${field}` }));
    return undefined;
  }
  const names: string[] = [];
  value.forEach((item: unknown, index: number) => {
    if (typeof item !== 'string' || item.trim() === '') {
      diagnostics.push(diagnostic('PLUGIN_POLICY_TYPE_INVALID', `plugins.${field}[${index}] must be a non-empty package name`, configPath, { field: `$.plugins.${field}[${index}]` }));
      return;
    }
    names.push(item);
  });
  return names;
}

/** Read policy with missing optional config distinct from every present-file failure. */
export async function readPluginPolicy(
  root: string,
): Promise<PluginPolicyResult> {
  let configPath: string;
  try {
    configPath = await resolveUserConfigFile(root, fs.access);
  } catch (error) {
    const fallback = `${root}/.kb/kb.config.jsonc`;
    return { kind: 'invalid', configPath: fallback, diagnostics: [diagnostic('CONFIG_PATH_RESOLUTION_FAILED', `Could not resolve plugin policy config path: ${String(error)}`, fallback, error)] };
  }
  try {
    await fs.access(configPath);
  } catch (error) {
    if (isMissing(error)) return { kind: 'valid', policy: {} };
    return { kind: 'invalid', configPath, diagnostics: [diagnostic('FILE_READ_FAILED', `Failed to access config file: ${configPath}`, configPath, error)] };
  }

  const result = await readJsonWithDiagnostics<{ plugins?: unknown }>(configPath, undefined, readFile);
  if (!result.ok) return { kind: 'invalid', configPath, diagnostics: result.diagnostics };

  const diagnostics: Diagnostic[] = [];
  if (result.data === null || typeof result.data !== 'object' || Array.isArray(result.data)) {
    return {
      kind: 'invalid',
      configPath,
      diagnostics: [diagnostic('CONFIG_SHAPE_INVALID', 'Config root must be an object containing the plugin policy', configPath)],
    };
  }
  const rootConfig = result.data as { plugins?: unknown };
  let rawPolicy: Record<string, unknown> | undefined;
  if (rootConfig.plugins !== undefined) {
    if (rootConfig.plugins === null || typeof rootConfig.plugins !== 'object' || Array.isArray(rootConfig.plugins)) {
      diagnostics.push(diagnostic('PLUGIN_POLICY_TYPE_INVALID', 'plugins must be an object containing allow, block, or linked arrays', configPath, { field: '$.plugins' }));
    } else {
      rawPolicy = rootConfig.plugins as Record<string, unknown>;
    }
  }
  const policy: PluginPolicy = {
    allow: readNames(rawPolicy?.allow, 'allow', configPath, diagnostics),
    block: readNames(rawPolicy?.block, 'block', configPath, diagnostics),
    linked: readNames(rawPolicy?.linked, 'linked', configPath, diagnostics),
  };
  return diagnostics.length > 0 ? { kind: 'invalid', configPath, diagnostics } : { kind: 'valid', policy };
}

export function checkPluginPolicy(policy: PluginPolicy, ids: string[], source: PluginProvenance): PolicyVerdict {
  if (isFirstPartyPluginSource(source)) return 'ok';
  if (policy.block?.some(blocked => ids.includes(blocked))) return 'blocked';
  if (policy.allow && !ids.some(id => policy.allow?.includes(id) || policy.linked?.includes(id))) return 'not-allowed';
  return 'ok';
}
