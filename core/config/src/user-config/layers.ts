/**
 * @module @kb-labs/core-config/user-config/layers
 *
 * Config layer model (ADR-0047, ADR-0012).
 *
 * Precedence, lowest to highest — a higher layer wins per key:
 *
 *   1. `manifest`   plugin settings defaults from the plugin manifest
 *   2. `generated`  `<platformRoot>/.kb/generated/*.json|jsonc`
 *   3. `platform`   `<platformRoot>/.kb/kb.config.*`
 *   4. `project`    `$KB_HOME/state/<projectId>/config.jsonc`
 *   5. `overlay`    `$KB_HOME/state/<projectId>/overlays/*.jsonc`
 *
 * The user config files are written ONLY by `setUserConfigValue` and
 * `unsetUserConfigValue`. One writer per file.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { readJsonWithDiagnostics } from '../runtime/runtime.js';
import { mergeOverlay } from '../overlay/merge.js';
import type { Diagnostic } from '../types/index.js';

export type ConfigLayerName = 'manifest' | 'generated' | 'platform' | 'container' | 'project' | 'overlay';

/** Layer names ordered from the lowest to the highest precedence. */
export const CONFIG_LAYER_ORDER: readonly ConfigLayerName[] = ['manifest', 'generated', 'platform', 'container', 'project', 'overlay'];

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

/** Read order is low-to-high; the first existing writer target wins last. */
export const PLATFORM_USER_CONFIG_CANDIDATES = [
  'kb.config.json',
  'kb.config.jsonc',
  path.join('.kb', 'kb.config.json'),
  path.join('.kb', 'kb.config.jsonc'),
] as const;

/** Absolute path of the user config file `config set` writes for a root. */
export async function resolveUserConfigFile(root: string, access: (filePath: string) => Promise<void> = (filePath) => fsp.access(filePath)): Promise<string> {
  for (const candidate of USER_CONFIG_CANDIDATES) {
    const full = path.join(root, candidate);
    try {
      await access(full);
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
  /** Merged contents of generated files in precedence order. */
  data: Record<string, unknown>;
  diagnostics: Diagnostic[];
}

export interface ConfigFilesLayerResult {
  files: ConfigLayerFile[];
  /** Existing paths in precedence order, including files with parse diagnostics. */
  paths: string[];
  data: Record<string, unknown>;
  diagnostics: Diagnostic[];
}

/** Read every platform user config candidate in the shared precedence order. */
export async function loadPlatformUserLayerFiles(root: string): Promise<ConfigFilesLayerResult> {
  return loadConfigFilesAtRoot(root, PLATFORM_USER_CONFIG_CANDIDATES, 'platform');
}

/** Read the optional Helm/container-owned platform override layer. */
export async function loadPlatformContainerLayer(root: string): Promise<ConfigFilesLayerResult> {
  return loadConfigFilesAtRoot(root, [path.join('.kb', 'kb.config.override.json')], 'container');
}

async function loadConfigFilesAtRoot(
  root: string,
  candidates: readonly string[],
  layer: 'platform' | 'container',
): Promise<ConfigFilesLayerResult> {
  const files: ConfigLayerFile[] = [];
  const paths: string[] = [];
  const diagnostics: Diagnostic[] = [];
  let data: Record<string, unknown> = {};

  for (const relative of candidates) {
    const full = path.join(root, relative);
    try {
      await fsp.access(full);
      paths.push(full);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      diagnostics.push({
        level: 'error',
        code: 'FILE_READ_FAILED',
        message: `Failed to read file: ${full}`,
        detail: String(error),
        path: full,
      });
      continue;
    }

    const read = await readJsonWithDiagnostics<unknown>(full);
    diagnostics.push(...read.diagnostics.map((diagnostic) => ({ ...diagnostic, path: diagnostic.path ?? full })));
    if (!read.ok) continue;
    if (read.data === null || typeof read.data !== 'object' || Array.isArray(read.data)) {
      diagnostics.push({
        level: 'error',
        code: 'CONFIG_NOT_OBJECT',
        message: `Config must be a JSON object at top level: ${full}`,
        path: full,
      });
      continue;
    }

    const object = read.data as Record<string, unknown>;
    files.push({ layer, path: full, data: object });
    data = mergeOverlay(data, object);
  }

  return { files, paths, data, diagnostics };
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
          path: dir,
        });
      }
      continue;
    }

    for (const name of names.filter((n) => n.endsWith('.json') || n.endsWith('.jsonc')).sort()) {
      const full = path.join(dir, name);
      const read = await readJsonWithDiagnostics<unknown>(full);
      diagnostics.push(...read.diagnostics.map((diagnostic) => ({ ...diagnostic, path: diagnostic.path ?? full })));
      if (!read.ok) {
        continue;
      }
      if (read.data === null || typeof read.data !== 'object' || Array.isArray(read.data)) {
        diagnostics.push({
          level: 'error',
          code: 'CONFIG_NOT_OBJECT',
          message: `Generated config must be a JSON object at top level: ${full}`,
          path: full,
        });
        continue;
      }
      const object = read.data as Record<string, unknown>;
      files.push({ layer: 'generated', path: full, data: object });
      data = mergeOverlay(data, object);
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
   * For arrays explicitly appended with `kb:merge`, each contributing layer
   * (highest first). Absent when one layer replaces the array.
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

function appendsArrayAt(data: unknown, segments: readonly string[]): boolean {
  const parent = valueAt(data, segments.slice(0, -1));
  if (!parent.found || !isPlainObject(parent.value)) {
    return false;
  }
  const directive = parent.value['kb:merge'];
  return isPlainObject(directive) && directive[segments.at(-1)!] === 'append';
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
        if (!appendsArrayAt(file.data, segments)) {
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
