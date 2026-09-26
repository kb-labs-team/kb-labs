/**
 * @module @kb-labs/core-config/user-config/layers
 *
 * Config layer model (ADR-0047, ADR-0012).
 *
 * Precedence, lowest to highest — a higher layer wins per key:
 *
 *   1. `generated`  `<root>/.kb/generated/*.json|jsonc`  written ONLY by the
 *                   installer / host; users never edit it. Files apply in
 *                   lexicographic order; the platform root's generated files
 *                   first, then the project root's.
 *   2. `platform`   platform-scope user config, `<platformRoot>/.kb/kb.config.*`
 *   3. `project`    project-scope user config, `<projectRoot>/.kb/kb.config.*`
 *                   (project wins over platform, ADR-0012)
 *   4. `overlay`    `<projectRoot>/.kb/overlays/*.jsonc` scenario overlays
 *
 * The user config files are written ONLY by `setUserConfigValue`
 * (`kb config set`). One writer per file.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { mergeDefined, readJsonWithDiagnostics } from '../runtime/runtime.js';
import type { Diagnostic } from '../types/index.js';

export type ConfigLayerName = 'generated' | 'platform' | 'project' | 'overlay';

/** Layer names ordered from the lowest to the highest precedence. */
export const CONFIG_LAYER_ORDER: readonly ConfigLayerName[] = ['generated', 'platform', 'project', 'overlay'];

/** Directory (relative to a root) that holds installer-written config. */
export const GENERATED_CONFIG_DIR = path.join('.kb', 'generated');

/**
 * Where a user config file may live, in priority order for WRITING (the first
 * that exists is the write target; `.kb/kb.config.jsonc` is created when none does).
 */
export const USER_CONFIG_CANDIDATES = [
  path.join('.kb', 'kb.config.jsonc'),
  path.join('.kb', 'kb.config.json'),
  'kb.config.jsonc',
  'kb.config.json',
] as const;

/** Absolute path of the user config file `config set` writes for a root. */
export async function resolveUserConfigFile(root: string): Promise<string> {
  for (const candidate of USER_CONFIG_CANDIDATES) {
    const full = path.join(root, candidate);
    try {
      await fsp.access(full);
      return full;
    } catch {
      // try the next candidate
    }
  }
  return path.join(root, USER_CONFIG_CANDIDATES[0]);
}

export interface ConfigLayerFile {
  layer: ConfigLayerName;
  /** Absolute path of the file. */
  path: string;
  /** Parsed contents (a plain object). */
  data: Record<string, unknown>;
}

export interface GeneratedLayerResult {
  files: ConfigLayerFile[];
  /** Deep-merged contents of all generated files. */
  data: Record<string, unknown>;
  diagnostics: Diagnostic[];
}

/**
 * Read the generated layer from the given roots (deduplicated, in order:
 * later roots win). Absent directories contribute nothing, so the loader keeps
 * working for installs that do not generate config yet.
 */
export async function loadGeneratedLayer(roots: readonly string[]): Promise<GeneratedLayerResult> {
  const files: ConfigLayerFile[] = [];
  const diagnostics: Diagnostic[] = [];
  let data: Record<string, unknown> = {};
  const seen = new Set<string>();

  for (const root of roots) {
    const dir = path.resolve(root, GENERATED_CONFIG_DIR);
    if (seen.has(dir)) {
      continue;
    }
    seen.add(dir);

    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        diagnostics.push({
          level: 'error',
          code: 'GENERATED_DIR_READ_FAILED',
          message: `Failed to read generated config directory: ${dir}`,
          detail: String(error),
        });
      }
      continue;
    }

    for (const name of names.filter((n) => n.endsWith('.json') || n.endsWith('.jsonc')).sort()) {
      const full = path.join(dir, name);
      const read = await readJsonWithDiagnostics<unknown>(full);
      diagnostics.push(...read.diagnostics);
      if (!read.ok) {
        continue;
      }
      if (read.data === null || typeof read.data !== 'object' || Array.isArray(read.data)) {
        diagnostics.push({
          level: 'error',
          code: 'CONFIG_NOT_OBJECT',
          message: `Generated config must be a JSON object at top level: ${full}`,
        });
        continue;
      }
      const object = read.data as Record<string, unknown>;
      files.push({ layer: 'generated', path: full, data: object });
      data = mergeDefined(data, object);
    }
  }

  return { files, data, diagnostics };
}

// ──────────────────────────────────────────────────────────────────────────
// Provenance
// ──────────────────────────────────────────────────────────────────────────

export interface ValueProvenance {
  /** Layer that supplied the effective value. */
  layer: ConfigLayerName;
  /** File that supplied it. */
  source: string;
  /**
   * For arrays, which concatenate across generated/platform/project layers, every
   * layer that contributed items (highest first). Absent for other values.
   */
  contributors?: Array<{ layer: ConfigLayerName; source: string }>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valueAt(data: unknown, segments: readonly string[]): { found: boolean; value?: unknown } {
  let current: unknown = data;
  for (const segment of segments) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

function collectLeaves(value: unknown, prefix: string[], out: string[][]): void {
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const [key, nested] of Object.entries(value)) {
      collectLeaves(nested, [...prefix, key], out);
    }
    return;
  }
  if (prefix.length > 0) {
    out.push(prefix);
  }
}

/**
 * Attribute every leaf of `merged` to the layer that supplied it: the highest
 * layer that defines that path wins. Arrays are leaves.
 *
 * `layers` must be ordered lowest to highest precedence, matching the merge.
 * Keys are dotted paths (a key that itself contains a dot is ambiguous; config
 * keys in this repo do not).
 */
export function buildProvenance(
  layers: readonly ConfigLayerFile[],
  merged: Record<string, unknown>,
): Record<string, ValueProvenance> {
  const result: Record<string, ValueProvenance> = {};
  const leaves: string[][] = [];
  collectLeaves(merged, [], leaves);

  for (const segments of leaves) {
    let winner: ConfigLayerFile | undefined;
    const contributors: Array<{ layer: ConfigLayerName; source: string }> = [];
    const leafValue = valueAt(merged, segments).value;

    for (let i = layers.length - 1; i >= 0; i--) {
      const file = layers[i]!;
      const hit = valueAt(file.data, segments);
      if (!hit.found) {
        continue;
      }
      winner ??= file;
      if (Array.isArray(leafValue) && Array.isArray(hit.value)) {
        contributors.push({ layer: file.layer, source: file.path });
        // Overlays replace arrays instead of concatenating: nothing below contributes.
        if (file.layer === 'overlay') {
          break;
        }
      } else {
        break;
      }
    }

    if (winner) {
      const entry: ValueProvenance = { layer: winner.layer, source: winner.path };
      if (contributors.length > 1) {
        entry.contributors = contributors;
      }
      result[segments.join('.')] = entry;
    }
  }
  return result;
}
