/**
 * @module @kb-labs/review/heuristic
 * Heuristic analysis engines for AI Review plugin.
 *
 * Provides CLI-based linter integration:
 * - ESLint (TypeScript/JavaScript)
 * - Ruff (Python)
 * - More coming: golangci-lint (Go), Clippy (Rust), etc.
 */

// Engine registry (for deduplication priorities)
export {
  ENGINE_REGISTRY,
  getEngine,
  getEnginesForLanguage,
  getEngineTypePriority,
} from './engine-registry.js';

// Deduplication
export {
  generateFingerprint,
  hashSnippet,
  deduplicateFindings,
  deduplicateFindingsWithSnippets,
} from './deduplication.js';

// Linter engines (CLI-based)
export {
  type LinterEngine,
  type LinterResult,
  eslintEngine,
  ruffEngine,
  LINTER_ENGINES,
  getLinterEngine,
  getLinterEngineForFile,
} from './engines/index.js';

// Linter runner
export {
  LinterRunner,
  type LinterRunnerConfig,
  runLinters,
  runLinter,
} from './runner.js';
