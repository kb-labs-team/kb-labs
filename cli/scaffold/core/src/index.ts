/**
 * @module @kb-labs/scaffold-core
 *
 * Pure engine for the scaffolder. Loads entity/block definitions from a
 * templates directory, renders file templates via eta, composes V3
 * manifest patches, and writes to disk transactionally.
 */

export { loadEntity, listEntities } from './loader/load-entity.js';
export { resolveBlocks } from './resolver/resolve-blocks.js';
export type { ResolveResult } from './resolver/resolve-blocks.js';
export { renderString, renderFilesDir } from './render/eta-renderer.js';
export {
  deepMerge,
  loadPatch,
  loadSnippets,
  mergeSnippets,
} from './patch/apply-patch.js';
export {
  writeFiles,
  inspectTarget,
  detectCollisions,
  formatTree,
} from './writer/write-files.js';
export type {
  WriteOptions,
  TargetState,
} from './writer/write-files.js';
export { build } from './engine.js';
export type { BuildInputs, BuildResult } from './engine.js';
export { emitManifest } from './emit/emit-manifest.js';
export { scanRoot, scanPackage } from './doctor/scan.js';
export type { Severity, Finding, ScanResult } from './doctor/scan.js';
export {
  validatePackageName,
  validateScope,
  validateSemver,
  validateIdentifier,
  runValidator,
} from './validators.js';
