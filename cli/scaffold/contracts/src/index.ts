/**
 * @module @kb-labs/scaffold-contracts
 *
 * Public types for the scaffold engine. The engine is entity-agnostic —
 * entities (plugin, adapter, etc.) are described declaratively via
 * `entity.yaml` + block directories. These types form the shape that
 * YAML is parsed into.
 */

export type VariableType = 'string' | 'boolean' | 'select' | 'multiselect';

export type VariableValidator =
  | 'identifier'
  | 'npmName'
  | 'semver'
  | 'npmScope';

export interface VariableChoice {
  value: string;
  label: string;
}

export interface Variable {
  name: string;
  type: VariableType;
  describe: string;
  default?: unknown;
  choices?: VariableChoice[];
  /** Simple boolean expression, e.g. `blocks.includes("rest")`. */
  when?: string;
  validate?: VariableValidator;
}

export interface BlockDefinition {
  id: string;
  describe: string;
  requires?: string[];
  conflicts?: string[];
  variables?: Variable[];
  /** Absolute path to the block's `files/` directory. */
  filesDir: string;
  /** Absolute path to `manifest.patch.yaml`, if the block contributes one. */
  manifestPatch?: string;
  /** Absolute path to `manifest.snippets.yaml`, for TS-string contributions. */
  snippetsPath?: string;
}

export interface EntityDefinition {
  id: string;
  displayName: string;
  description?: string;
  variables: Variable[];
  blocks: BlockDefinition[];
  defaults?: { blocks?: string[] };
  /**
   * Output path template evaluated with entity + user variables.
   * Example: `.kb/plugins/{{name}}` or `plugins/{{name}}`.
   */
  output?: string;
  /**
   * Relative path inside the scaffolded output where the generated
   * `manifest.ts` should land. Template-evaluated. Defaults to
   * `src/manifest.ts` (suitable for flat adapter layouts).
   */
  manifestTarget?: string;
}

export type ScaffoldMode = 'in-workspace' | 'standalone';

export interface RenderContext {
  name: string;
  scope: string;
  vars: Record<string, unknown>;
  blocks: string[];
  mode: ScaffoldMode;
  versions: Record<string, string>;
}

export interface RenderedFile {
  /** Path relative to the scaffold output root. */
  path: string;
  contents: string;
  /** If true, preserve executable bit on unix. */
  executable?: boolean;
}

/**
 * Deep-mergeable patch applied on top of the V3 manifest skeleton produced
 * by the `base` block. Arrays of objects with `id` or `name` are merged as
 * unions by key; primitive arrays are Set-deduped.
 */
export type ManifestPatch = Record<string, unknown>;

export interface PatchContext {
  vars: Record<string, unknown>;
  blocks: string[];
}

/**
 * TS-string snippets contributed by blocks and composed into the final
 * `src/manifest.ts` (imports, permissions fragments, etc.).
 */
export interface ManifestSnippets {
  imports?: string[];
  permissions?: string[];
  extras?: Record<string, string[]>;
}
