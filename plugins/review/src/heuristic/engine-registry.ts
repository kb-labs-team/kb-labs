/**
 * @module @kb-labs/review/heuristic/engine-registry
 * Registry of heuristic analysis engines with type mappings.
 *
 * Maps specific tools (eslint, ruff, clippy) to engine types (linter, compiler, sast).
 * Used for engine type priority deduplication.
 */

import type { HeuristicEngine } from '../contracts/index.js';

/**
 * Registry of all supported heuristic engines.
 *
 * Engine types determine priority in deduplication:
 * - compiler (1): TypeScript compiler, rustc, go build
 * - linter (2): ESLint, Ruff, golangci-lint, Clippy, RuboCop
 * - sast (3): Semgrep, CodeQL, Bandit
 * - ast (4): tree-sitter (read-only AST analysis)
 */
export const ENGINE_REGISTRY: Record<string, HeuristicEngine> = {
  // JavaScript/TypeScript linters
  eslint: {
    id: 'eslint',
    name: 'ESLint',
    language: ['typescript', 'javascript', 'tsx', 'jsx'],
    type: 'linter',
  },

  // TypeScript compiler
  tsc: {
    id: 'tsc',
    name: 'TypeScript Compiler',
    language: ['typescript', 'tsx'],
    type: 'compiler',
  },

  // Python linters
  ruff: {
    id: 'ruff',
    name: 'Ruff',
    language: ['python'],
    type: 'linter',
  },

  pylint: {
    id: 'pylint',
    name: 'Pylint',
    language: ['python'],
    type: 'linter',
  },

  // Python SAST
  bandit: {
    id: 'bandit',
    name: 'Bandit',
    language: ['python'],
    type: 'sast',
  },

  // Go linter
  golangci: {
    id: 'golangci',
    name: 'golangci-lint',
    language: ['go'],
    type: 'linter',
  },

  // Rust linter
  clippy: {
    id: 'clippy',
    name: 'Clippy',
    language: ['rust'],
    type: 'linter',
  },

  // Ruby linter
  rubocop: {
    id: 'rubocop',
    name: 'RuboCop',
    language: ['ruby'],
    type: 'linter',
  },

  // Multi-language SAST
  semgrep: {
    id: 'semgrep',
    name: 'Semgrep',
    language: ['typescript', 'javascript', 'python', 'go', 'rust', 'ruby'],
    type: 'sast',
  },

  codeql: {
    id: 'codeql',
    name: 'CodeQL',
    language: ['typescript', 'javascript', 'python', 'go', 'rust', 'ruby'],
    type: 'sast',
  },

  // AST-based analysis (read-only)
  treesitter: {
    id: 'treesitter',
    name: 'Tree-sitter',
    language: ['typescript', 'javascript', 'python', 'go', 'rust', 'ruby'],
    type: 'ast',
  },
};

/**
 * Get engine by ID.
 */
export function getEngine(engineId: string): HeuristicEngine | undefined {
  return ENGINE_REGISTRY[engineId];
}

/**
 * Get all engines supporting a language.
 */
export function getEnginesForLanguage(language: string): HeuristicEngine[] {
  return Object.values(ENGINE_REGISTRY).filter((engine) =>
    engine.language.includes(language)
  );
}

/**
 * Get engine type priority for deduplication.
 *
 * Lower number = higher priority (kept in deduplication).
 * - compiler (1) - highest priority
 * - linter (2)
 * - sast (3)
 * - ast (4)
 * - llm (5) - lowest priority
 */
export function getEngineTypePriority(engineId: string): number {
  const engine = getEngine(engineId);
  if (!engine) {
    // Unknown engine, treat as lowest priority
    return 999;
  }

  const typePriority: Record<string, number> = {
    compiler: 1,
    linter: 2,
    sast: 3,
    ast: 4,
    llm: 5,
  };

  return typePriority[engine.type] ?? 999;
}
