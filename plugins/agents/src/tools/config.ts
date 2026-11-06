/**
 * Centralized configuration constants for agent tools.
 *
 * All magic numbers and default values live here — tool implementations
 * import from this module instead of defining inline constants.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Filesystem tool config
// ═══════════════════════════════════════════════════════════════════════════

export const FILESYSTEM_CONFIG = {
  /** Hard cap on file size to read (500KB) — prevents context overflow */
  maxFileSize: 500_000,
  /** Hard cap on lines returned per read — prevents context overflow */
  maxLinesPerRead: 2_000,
  /** Default lines to return when not specified — read whole file up to maxLinesPerRead */
  defaultLines: 2_000,
  /** Hard cap on content size for write operations (1MB) */
  maxWriteSize: 1_000_000,
  /** Default limit for directory listing */
  defaultListLimit: 50,
  /** Maximum limit for directory listing */
  maxListLimit: 200,
  /** Max output characters before trimming (prevents context explosion) */
  maxOutputChars: 12_000,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Search tool config
// ═══════════════════════════════════════════════════════════════════════════

export const SEARCH_CONFIG = {
  /** Timeout for search commands (15s) — fail fast, don't burn iterations */
  timeoutMs: 15_000,
  /** Max stdout buffer for search commands (8MB) */
  maxBuffer: 8 * 1024 * 1024,
  /** Default result limit — enough for actionable results */
  defaultResultLimit: 50,
  /** Maximum result limit */
  maxResultLimit: 200,
  /** Max output characters before trimming */
  maxOutputChars: 8_000,
  /**
   * Directories excluded from search by default.
   * These are never useful for code understanding and often huge.
   * Pass exclude=[] to override entirely, or exclude=[...custom] to replace the list.
   */
  defaultExcludes: [
    'node_modules', '.git', 'dist', 'build', '.next',
    '.kb', '.pnpm', 'coverage', '__pycache__', '.venv', '.cache',
  ] as string[],
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Shell tool config
// ═══════════════════════════════════════════════════════════════════════════

export const SHELL_CONFIG = {
  /** Max stdout buffer — aligned with SEARCH_CONFIG (16MB) */
  maxBuffer: 16 * 1024 * 1024,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// TODO tool config
// ═══════════════════════════════════════════════════════════════════════════

export const TODO_CONFIG = {
  /** Cache key prefix for todo lists */
  cachePrefix: 'agent:todo:',
  /** TTL for cached todo lists (7 days) */
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Delegation tool config
// ═══════════════════════════════════════════════════════════════════════════

export const DELEGATION_CONFIG = {
  /** Default max iterations for spawned sub-agents (safety net — token budget is primary control) */
  defaultMaxIterations: 100,
  /** Default budget fraction (50% of parent remaining — sub-agents need real budget) */
  defaultBudgetFraction: 0.5,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Sub-agent presets
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sub-agent tool allowlists and iteration defaults per preset.
 *
 * Single source of truth: lives in agent-tools because it knows tool names.
 * agent-core receives these as `allowedTools: string[]` data via SpawnAgentRequest
 * (no import from agent-tools needed — correct dependency direction).
 */
export const SUB_AGENT_PRESETS = {
  /** Read-only exploration and evidence gathering. */
  research: {
    tools: new Set<string>([
      'fs_read', 'fs_list',
      'glob_search', 'grep_search', 'find_definition', 'code_stats',
      'memory_get', 'memory_finding', 'archive_recall',
      'todo_get',
      'report',
    ]),
    maxIterations: 50,
  },
  /** Full read/write capabilities for implementation tasks. */
  execute: {
    tools: new Set<string>([
      'fs_read', 'fs_write', 'fs_patch', 'fs_replace', 'fs_list', 'mass_replace',
      'glob_search', 'grep_search', 'find_definition', 'code_stats',
      'shell_exec',
      'memory_get', 'memory_finding', 'memory_blocker', 'memory_correction',
      'todo_create', 'todo_update', 'todo_get',
      'plan_write',
      'ask_user', 'report',
    ]),
    maxIterations: 100,
  },
  /** Code review and verification: read + shell (linters, tests). */
  review: {
    tools: new Set<string>([
      'fs_read', 'fs_list',
      'glob_search', 'grep_search', 'find_definition', 'code_stats',
      'shell_exec',
      'memory_get', 'memory_finding', 'archive_recall',
      'todo_get',
      'report',
    ]),
    maxIterations: 50,
  },
  /**
   * Adversarial verification: independent agent that checks another agent's work.
   * Has read + shell access to run tests, check imports, verify builds.
   * Reports PASS/FAIL verdict with evidence.
   */
  verification: {
    tools: new Set<string>([
      'fs_read', 'fs_list',
      'glob_search', 'grep_search', 'find_definition', 'code_stats',
      'shell_exec',
      'report',
    ]),
    maxIterations: 25,
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Mass replace tool config
// ═══════════════════════════════════════════════════════════════════════════

export const MASS_REPLACE_CONFIG = {
  /** Hard cap on file size to process (1MB) — same as maxWriteSize */
  maxFileSize: 1_000_000,
  /** Maximum number of files to process in one operation */
  maxFiles: 100,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Plan mode tool allowlist
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tools available in plan mode — read-only exploration + async task delegation.
 * Used as `allowedTools` in ToolContext for both the plan-writer and any
 * research sub-agents it spawns via task_submit. Single source of truth:
 * lives in agent-tools so both agent-core and tests can import it without
 * creating a circular dependency.
 */
export const PLAN_READ_ONLY_TOOL_NAMES = new Set<string>([
  'fs_read',
  'fs_list',
  'glob_search',
  'grep_search',
  'find_definition',
  'code_stats',
  'memory_get',
  'memory_finding',
  'memory_blocker',
  'archive_recall',
  'todo_create',
  'todo_update',
  'todo_get',
  'ask_user',
  'report',
  'task_submit',    // plan-writer can delegate research to async sub-agents
  'task_status',    // check progress of delegated tasks
  'task_collect',   // wait for and collect sub-agent results
  'plan_validate',  // LLM-based plan quality gate (agent calls this to self-assess before report)
  'plan_write',     // Write/update plan file on disk (iterative plan building)
]);

// ═══════════════════════════════════════════════════════════════════════════
// Source file extensions — single source of truth
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Source file extensions grouped by language.
 * Use ALL_SOURCE_EXTENSIONS or the helper functions for CLI flags.
 */
export const SOURCE_FILE_EXTENSIONS = {
  typescript: ['ts', 'tsx'],
  javascript: ['js', 'jsx'],
  python: ['py'],
  csharp: ['cs'],
  java: ['java'],
  go: ['go'],
  rust: ['rs'],
  ruby: ['rb'],
  php: ['php'],
  swift: ['swift'],
  kotlin: ['kt'],
  scala: ['scala'],
  cpp: ['cpp', 'c', 'h', 'cc', 'cxx'],
} as const;

/** Flat list of all source file extensions */
export const ALL_SOURCE_EXTENSIONS: readonly string[] = Object.values(SOURCE_FILE_EXTENSIONS).flat();

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * Build `--include='*.ext'` flags for ripgrep / grep.
 * @example toRgIncludes(ALL_SOURCE_EXTENSIONS)
 * // → "--include='*.ts' --include='*.tsx' ..."
 */
export function toRgIncludes(exts: readonly string[]): string {
  return exts.map(e => `--include=${shellSingleQuote(`*.${e}`)}`).join(' ');
}

/**
 * Build `--include=*.ext` args for grep when using execa array mode (no shell).
 * @example toRgIncludesArgs(['ts', 'tsx'])
 * // → ['--include=*.ts', '--include=*.tsx']
 */
export function toRgIncludesArgs(exts: readonly string[]): string[] {
  return exts.map(e => `--include=*.${e}`);
}

/**
 * Build `-name '*.ext'` flags for `find` (joined with ` -o `).
 * @example toFindNames(ALL_SOURCE_EXTENSIONS)
 * // → "-name '*.ts' -o -name '*.tsx' ..."
 */
export function toFindNames(exts: readonly string[]): string {
  return exts.map(e => `-name ${shellSingleQuote(`*.${e}`)}`).join(' -o ');
}

/**
 * Build `-name *.ext` args for `find` when using execa array mode (no shell).
 * Returns a flat list of alternating pairs: ['-name', '*.ts', '-o', '-name', '*.tsx', ...]
 * with no leading/trailing `-o`.
 * @example toFindNamesArgs(['ts', 'tsx'])
 * // → ['-name', '*.ts', '-o', '-name', '*.tsx']
 */
export function toFindNamesArgs(exts: readonly string[]): string[] {
  if (exts.length === 0) {return [];}
  const result: string[] = [];
  for (let i = 0; i < exts.length; i++) {
    if (i > 0) {result.push('-o');}
    result.push('-name', `*.${exts[i]}`);
  }
  return result;
}
