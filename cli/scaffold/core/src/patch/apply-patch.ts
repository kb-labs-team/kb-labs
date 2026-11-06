import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type {
  ManifestPatch,
  ManifestSnippets,
  RenderContext,
} from '@kb-labs/scaffold-contracts';
import { renderString } from '../render/eta-renderer.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

function mergeArrays(a: unknown[], b: unknown[]): unknown[] {
  const allObjects =
    a.every(isPlainObject) && b.every(isPlainObject) && a.length + b.length > 0;

  if (allObjects) {
    const keyOf = (x: Record<string, unknown>): string | null => {
      if (typeof x.id === 'string') {return `id:${x.id}`;}
      if (typeof x.name === 'string') {return `name:${x.name}`;}
      return null;
    };
    const allKeyed =
      a.every((x) => keyOf(x as Record<string, unknown>) !== null) &&
      b.every((x) => keyOf(x as Record<string, unknown>) !== null);

    if (allKeyed) {
      const byKey = new Map<string, Record<string, unknown>>();
      for (const item of [...a, ...b] as Record<string, unknown>[]) {
        const k = keyOf(item)!;
        const prev = byKey.get(k);
        byKey.set(k, prev ? deepMerge(prev, item) : item);
      }
      return [...byKey.values()];
    }
  }

  // Primitive or mixed: Set-dedupe where possible.
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of [...a, ...b]) {
    const key = JSON.stringify(item);
    if (seen.has(key)) {continue;}
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      out[key] = mergeArrays(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Load a manifest.patch.yaml from disk, render it through eta with the
 * render context, parse as YAML, and return the resulting object.
 */
export async function loadPatch(
  path: string,
  ctx: RenderContext,
): Promise<ManifestPatch> {
  const raw = await readFile(path, 'utf8');
  const rendered = renderString(raw, ctx);
  const parsed = parseYaml(rendered);
  if (parsed == null) {return {};}
  if (!isPlainObject(parsed)) {
    throw new Error(`Patch at ${path} must be a YAML object`);
  }
  return parsed;
}

export async function loadSnippets(
  path: string,
  ctx: RenderContext,
): Promise<ManifestSnippets> {
  const raw = await readFile(path, 'utf8');
  const rendered = renderString(raw, ctx);
  const parsed = parseYaml(rendered);
  if (parsed == null) {return {};}
  if (!isPlainObject(parsed)) {
    throw new Error(`Snippets at ${path} must be a YAML object`);
  }
  return parsed as ManifestSnippets;
}

export function mergeSnippets(
  a: ManifestSnippets,
  b: ManifestSnippets,
): ManifestSnippets {
  const mergedExtras: Record<string, string[]> = { ...(a.extras ?? {}) };
  for (const [k, v] of Object.entries(b.extras ?? {})) {
    mergedExtras[k] = dedupe([...(mergedExtras[k] ?? []), ...v]);
  }
  return {
    imports: dedupe([...(a.imports ?? []), ...(b.imports ?? [])]),
    permissions: dedupe([
      ...(a.permissions ?? []),
      ...(b.permissions ?? []),
    ]),
    extras: Object.keys(mergedExtras).length > 0 ? mergedExtras : undefined,
  };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
