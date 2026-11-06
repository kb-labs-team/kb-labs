/**
 * @module @kb-labs/review/contracts/types
 * Core type definitions for AI Review plugin
 */

/**
 * Engine types (not specific tools!)
 * Used for deduplication priority
 */
export type EngineType =
  | 'compiler'    // TypeScript compiler, rustc, go build
  | 'linter'      // ESLint, Ruff, golangci-lint, Clippy, RuboCop
  | 'sast'        // Semgrep, CodeQL, Bandit
  | 'ast'         // tree-sitter (read-only AST analysis)
  | 'llm';        // LLM-based analysis

/**
 * Engine registry entry
 * Maps concrete tools to engine types
 */
export interface HeuristicEngine {
  id: string;           // 'eslint', 'ruff', 'golangci', 'clippy'
  name: string;
  language: string[];   // ['typescript', 'javascript']
  type: EngineType;     // Maps to priority tier
}

/**
 * Rule categories
 */
export type RuleCategory =
  | 'style'
  | 'correctness'
  | 'security'
  | 'architecture'
  | 'maintainability';

/**
 * Finding severity levels
 */
export type FindingSeverity =
  | 'blocker'
  | 'high'
  | 'medium'
  | 'low'
  | 'info';

/**
 * Confidence levels for findings
 * Critical for agent gating!
 */
export type FindingConfidence =
  | 'certain'     // Deterministic, can be auto-fixed
  | 'likely'      // High confidence but needs human review
  | 'heuristic';  // Pattern-based, might have false positives

/**
 * Review modes
 */
export type ReviewMode =
  | 'heuristic'   // Fast, deterministic (default in CI)
  | 'llm'         // LLM-only (for complex analysis)
  | 'full';       // Heuristic + LLM (local development)

/**
 * Unified rule contract
 * All rules (heuristic/LLM) follow same contract
 */
export interface ReviewRule {
  id: string;                   // Stable ID (e.g., "eslint:no-unused-vars")
  title: string;
  category: RuleCategory;
  severity: FindingSeverity;
  engine: string;               // Engine ID (e.g., 'eslint', 'ruff')
  confidence: FindingConfidence;

  rationale?: string;           // Why this rule exists
  references?: string[];        // ADR/doc links
  quickFix?: FixTemplate[];     // Concrete fix (if available)
}

/**
 * Fix template for auto-fixing
 */
export interface FixTemplate {
  type: 'replace' | 'insert' | 'delete';
  pattern?: string;             // Regex pattern to match
  replacement?: string;         // Replacement text
  position?: {
    line: number;
    column: number;
  };
}

/**
 * Review finding
 */
export interface ReviewFinding {
  id: string;                   // Unique finding ID
  ruleId: string;               // Rule that generated this finding
  type: string;                 // Finding type (e.g., 'security', 'style')
  severity: FindingSeverity;
  confidence: FindingConfidence;
  
  file: string;                 // File path
  line: number;                 // Line number
  column?: number;              // Column number (optional)
  endLine?: number;             // End line for multi-line findings
  
  message: string;              // Human-readable message
  snippet?: string;             // Code snippet showing the issue
  suggestion?: string;          // Suggested fix
  rationale?: string;           // Why this is an issue
  
  engine: string;               // Which engine found this
  source: string;               // Source identifier (e.g., 'eslint', 'llm-architecture')
  
  fix?: FixTemplate[];          // Auto-fix instructions
  
  // For agent mode gating
  scope?: 'local' | 'global';   // 1-2 files (local) vs architecture redesign (global)
  automated?: boolean;          // Can be auto-applied?
}

/**
 * Finding fingerprint for deduplication
 */
export interface FindingFingerprint {
  key: string;                  // sha1(ruleId|file|bucket|snippetHash)
  bucket: {
    file: string;
    lineStart: number;          // line - 2
    lineEnd: number;            // line + 2
  };
  snippetHash: string;          // normalizeWhitespace(snippet).slice(0, 100) + hash
}

/**
 * Parsed file for analysis
 */
export interface ParsedFile {
  path: string;
  content: string;
  contentHash: string;          // For deterministic caching
  language: string;             // Detected language
  ast?: unknown;                // Optional AST (if available)
}

/**
 * Review context for LLM analyzers
 */
export interface ReviewContext {
  preset: string;               // Preset ID
  file: string;                 // Current file being analyzed

  // TASK CONTEXT: What is being reviewed and why
  taskContext?: string;         // Description of the task (e.g., "Add multi-tenancy support")
  repoScope?: string[];         // Which repos are part of this task

  // PRIMARY: Static documents from preset (always available)
  documents: Document[];

  // OPTIONAL: Dynamic examples via Mind RAG (when available)
  examples: Example[];

  // OPTIONAL: Related ADRs (when Mind RAG available)
  relatedADRs: ADR[];

  // PRIMARY: Project conventions from atomic rules
  // Key = category name (e.g., 'naming', 'architecture', 'consistency')
  // Value = composed markdown content from all rules in category
  conventions: Record<string, string>;
}

/**
 * Static document (from preset config)
 */
export interface Document {
  id: string;
  title: string;
  content: string;
  type: 'rule' | 'convention' | 'guide';
}

/**
 * Example from codebase (via Mind RAG)
 */
export interface Example {
  file: string;
  snippet: string;
  description: string;
}

/**
 * Architecture Decision Record
 */
export interface ADR {
  id: string;
  title: string;
  path: string;
  summary: string;
}


/**
 * LLM Analyzer interface
 */
export interface LLMAnalyzer {
  readonly id: string;
  readonly name: string;

  analyze(files: ParsedFile[], context: ReviewContext): Promise<ReviewFinding[]>;
}

/**
 * Input file (from CLI layer)
 * Simple file representation before orchestrator parsing
 */
export interface InputFile {
  path: string;
  content: string;
  /** Whether this is a newly created (untracked) file */
  isNewFile?: boolean;
}

/**
 * Review request
 */
export interface ReviewRequest {
  files: InputFile[];               // Simple files - orchestrator will parse to ParsedFile
  mode: ReviewMode;
  presetId: string;

  // Additional context
  cwd?: string;                     // Working directory

  // Task context for LLM (what are we trying to achieve?)
  taskContext?: string;             // Description of the task being reviewed

  // Scope for diff-based review (submodule names)
  // When provided, system collects git diff from these repos
  repoScope?: string[];             // ['kb-labs-core', 'kb-labs-cli']

  config?: {                        // Engine-specific configuration
    eslintConfig?: string;          // Path to ESLint config
    ruffConfig?: string;            // Path to Ruff config (future)
    golangciConfig?: string;        // Path to golangci-lint config (future)
    clippyConfig?: string;          // Path to Clippy config (future)
  };
}

/**
 * Review preset configuration
 */
export interface ReviewPreset {
  id: string;
  name: string;
  description?: string;

  rules: string[];              // Rule IDs to enable
  excludeRules?: string[];      // Rule IDs to disable

  llm?: {
    enabled: boolean;           // Enable LLM analysis?
    analyzers: string[];        // Which LLM analyzers to run
  };

  severity?: {
    failOn?: FindingSeverity;   // Exit with error if severity >= this
  };

  // LLM context (for LLM analyzers)
  documents?: Document[];       // Static documents (guides, rules)
}

/**
 * Engine configuration within a preset
 */
export interface PresetEngineConfig {
  enabled: boolean;
  rules?: string[];             // Override which rules to enable
  config?: Record<string, unknown>;  // Engine-specific config
}

/**
 * LLM analyzer context - passed to LLM analyzers for guidance
 */
export interface LLMAnalyzerContext {
  projectType?: string;         // 'monorepo' | 'library' | 'application'
  framework?: string;           // 'nodejs' | 'react' | 'next.js'
  language?: string;            // 'typescript' | 'javascript' | 'python'

  // Dynamic conventions - any category name is valid
  // Categories map to .kb/review/rules/{category}/ directories
  // Common categories: naming, architecture, security, testing, performance, errorHandling, consistency
  conventions?: Record<string, string>;

  adrs?: string[];              // ADR references for context
}

/**
 * Detailed preset configuration with engine-specific settings
 */
export interface PresetDefinition extends ReviewPreset {
  // Preset inheritance
  extends?: string;             // Inherit from another preset (e.g., 'kb-labs', 'default')

  // Engine-specific configuration
  engines?: {
    eslint?: PresetEngineConfig;
    ruff?: PresetEngineConfig;
    golangci?: PresetEngineConfig;
    clippy?: PresetEngineConfig;
  };

  // File patterns
  include?: string[];           // Patterns to include
  exclude?: string[];           // Patterns to exclude

  // Performance tuning
  maxConcurrent?: number;       // Max concurrent engine runs
  timeout?: number;             // Timeout per file (ms)

  // LLM Analyzer context (guides LLM analyzers)
  context?: LLMAnalyzerContext;

  // Atomic rules composition (ESLint-style)
  // Dynamic categories - any category name is valid
  // Categories are defined by directory structure in .kb/review/rules/{category}/
  atomicRules?: Record<string, {
    include?: string[];       // Include specific rules (e.g., ['pyramid-rule', 'typescript-naming'])
    exclude?: string[];       // Exclude specific rules
  }>;
}

/**
 * Review result
 */
export interface ReviewResult {
  findings: ReviewFinding[];
  summary: ReviewSummary;
  metadata: ReviewMetadata;
}

/**
 * Review summary statistics
 */
export interface ReviewSummary {
  total: number;
  bySeverity: {
    error: number;
    warning: number;
    info: number;
  };
  byType: Record<string, number>;
}

/**
 * Review metadata
 */
export interface ReviewMetadata {
  preset: string;
  mode: ReviewMode;
  filesReviewed: number;
  analyzedFiles: number;           // Alias for filesReviewed (for backward compat)
  heuristicFindings: number;
  llmFindings: number;
  totalFindings: number;
  durationMs: number;
  engines: string[];                // List of engines used (e.g., ['eslint', 'ruff'])

  // LLM-Lite specific metadata (v2)
  llmLite?: LLMLiteMetadata;

  // Incremental review metadata
  incremental?: IncrementalMetadata;
}

/**
 * Incremental review metadata
 * Tracks cached files and new vs known findings
 */
export interface IncrementalMetadata {
  /** Files skipped (unchanged, used cache) */
  cachedFiles: number;
  /** Files analyzed fresh */
  analyzedFiles: number;
  /** New findings (not seen before) */
  newFindings: number;
  /** Known findings (seen in previous review) */
  knownFindings: number;
  /** Findings from cached files */
  cachedFindings: number;
}

/**
 * LLM-Lite analysis metadata (v2)
 * Detailed stats for batch tool-based review
 */
export interface LLMLiteMetadata {
  /** Number of LLM API calls */
  llmCalls: number;

  /** Tool call counts */
  toolCalls: {
    get_diffs: number;
    get_file_chunks: number;
    report_findings: number;
  };

  /** Token usage */
  tokens: {
    input: number;
    output: number;
    total: number;
  };

  /** Estimated cost in USD */
  estimatedCost: number;

  /** Verification stats */
  verification: {
    /** Raw findings before verification */
    rawFindings: number;
    /** Findings that passed verification */
    verified: number;
    /** Findings downgraded due to uncertainty */
    downgraded: number;
    /** Findings discarded as hallucinations */
    discarded: number;
    /** Hallucination rate (0.0-1.0) */
    hallucinationRate: number;
  };

  /** Timing breakdown */
  timing: {
    /** Total analysis time (ms) */
    totalMs: number;
    /** Time spent on LLM calls (ms) */
    llmMs: number;
    /** Time spent on verification (ms) */
    verifyMs: number;
  };
}


/**
 * Review configuration in kb.config.json
 */
export interface ReviewConfig {
  // Default preset to use
  defaultPreset?: string;

  // Presets directory (relative to .kb/)
  presetsDir?: string;

  // Custom presets (inline definitions or file paths)
  presets?: Array<PresetDefinition | string>;

  // Engine configurations
  engines?: {
    eslint?: {
      configPath?: string;        // Path to ESLint config
      enabled?: boolean;
    };
    ruff?: {
      configPath?: string;
      enabled?: boolean;
    };
    golangci?: {
      configPath?: string;
      enabled?: boolean;
    };
    clippy?: {
      enabled?: boolean;
    };
  };

  // File patterns to include/exclude globally
  include?: string[];
  exclude?: string[];

  // Custom analyzers directory (default: .kb/review/analyzers)
  analyzersDir?: string;

  // Rules directory (relative to .kb/, default: review/rules)
  rulesDir?: string;

  // Prompts directory (relative to .kb/, default: review/prompts)
  promptsDir?: string;

  // LLM configuration for llm-lite mode
  llm?: {
    // Minimum turns for LLM conversation (default: 3)
    minTurns?: number;
    // Maximum turns for LLM conversation (default: 25)
    maxTurns?: number;
    // Files per turn for adaptive calculation (default: 10)
    filesPerTurn?: number;
    // Lines per turn for adaptive calculation (default: 500)
    linesPerTurn?: number;
  };
}

/**
 * Base LLM analyzer class
 * Extend this to create custom analyzers
 */
export abstract class BaseLLMAnalyzer implements LLMAnalyzer {
  abstract readonly id: string;
  abstract readonly name: string;

  abstract analyze(files: ParsedFile[], context: ReviewContext): Promise<ReviewFinding[]>;

  /**
   * Generate cache key for file + preset combination
   */
  protected generateCacheKey(file: ParsedFile, preset: string): string {
    return `review:${this.id}:${file.contentHash}:${preset}`;
  }

  /**
   * Build finding ID
   */
  protected buildFindingId(file: ParsedFile, line: number, type: string): string {
    return `${this.id}-${file.path}-${line}-${type}`;
  }
}

// =============================================================================
// Diff Provider Types (for LLM-Lite mode)
// =============================================================================

/**
 * Parsed diff hunk with line information
 */
export interface DiffHunk {
  /** Starting line in new file (1-indexed) */
  newStart: number;
  /** Number of lines in new file */
  newLines: number;
  /** Starting line in old file (1-indexed) */
  oldStart: number;
  /** Number of lines in old file */
  oldLines: number;
  /** Raw hunk content (unified diff format) */
  content: string;
  /** Lines that were added */
  addedLines: number[];
  /** Lines that were deleted (relative to old file) */
  deletedLines: number[];
}

/**
 * File diff with parsed hunks
 */
export interface FileDiff {
  /** File path (relative to repo root) */
  file: string;
  /** Raw unified diff */
  diff: string;
  /** Number of lines added */
  additions: number;
  /** Number of lines deleted */
  deletions: number;
  /** Whether this is a new file */
  isNewFile: boolean;
  /** Whether this is a deleted file */
  isDeleted: boolean;
  /** Whether this is a renamed file */
  isRenamed: boolean;
  /** Parsed hunks */
  hunks: DiffHunk[];
  /** Set of changed line numbers (in new file) */
  changedLines: Set<number>;
}

/**
 * Batch diff request
 */
export interface BatchDiffRequest {
  /** Directory containing .git */
  cwd: string;
  /** Files to get diffs for */
  files: string[];
  /** Include staged changes */
  staged?: boolean;
  /** Include unstaged changes */
  unstaged?: boolean;
  /** Max lines per file diff (truncate large diffs) */
  maxLinesPerFile?: number;
}

/**
 * Batch diff result
 */
export interface BatchDiffResult {
  /** Successfully fetched diffs */
  diffs: FileDiff[];
  /** Files that failed to fetch */
  errors: Array<{ file: string; error: string }>;
  /** Total lines in all diffs */
  totalLines: number;
}

/**
 * DiffProvider interface (implementation in review-core)
 */
export interface IDiffProvider {
  getDiffs(request: BatchDiffRequest): Promise<BatchDiffResult>;
  getFileDiff(file: string, staged?: boolean, unstaged?: boolean, maxLines?: number): Promise<FileDiff | null>;
  isLineInDiff(fileDiff: FileDiff, lineNumber: number): boolean;
  getLineContext(file: string, lineNumber: number, contextLines?: number): Promise<{ lines: string[]; startLine: number } | null>;
}
