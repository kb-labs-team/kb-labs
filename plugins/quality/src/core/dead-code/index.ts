/**
 * @module @kb-labs/quality/core/dead-code
 * Dead code file detection using reachability analysis
 */

export { scanDeadFiles } from './scan-dead-files.js';
export { runKnip } from './knip-runner.js';
export { collectEntryPoints, parseTsupEntries, parseManifestHandlers, distPathToSrcPath } from './entry-points.js';
export { extractFileImports, resolveRelativeImport, buildFileImportGraph, findReachableFiles } from './import-graph.js';
export { removeDeadFiles, restoreFromBackup, listBackups } from './backup.js';
