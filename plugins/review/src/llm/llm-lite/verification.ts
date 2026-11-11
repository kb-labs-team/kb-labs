/**
 * @module @kb-labs/review/llm/llm-lite/verification
 * Anti-hallucination verification for LLM findings.
 *
 * Validates LLM output against actual code to filter hallucinations.
 */

import type { FileDiff } from '../../contracts/index.js';
import type { RawFinding, RawFindingSeverity } from './tool-executor.js';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Verification check results
 */
export interface VerificationChecks {
  /** Is severity a valid enum value? */
  severityValid: boolean;
  /** Is category a valid enum value? */
  categoryValid: boolean;
  /** Is file in the changed files list? */
  fileExists: boolean;
  /** Is line number within file bounds? */
  lineInBounds: boolean;
  /** Is line actually in the diff (changed)? */
  lineInDiff: boolean;
  /** Fuzzy match score for code snippet (0.0-1.0) */
  snippetMatch: number;
  /** Does the issue make sense for this file type? */
  contextValid: boolean;
  /** Is ruleId valid (matches a project rule) or null? */
  ruleIdValid: boolean;
}

/**
 * Verified finding with score
 */
export interface VerifiedFinding {
  /** Original finding */
  finding: RawFinding;
  /** Verification score (0.0-1.0) */
  score: number;
  /** Individual check results */
  checks: VerificationChecks;
  /** Action taken based on score */
  action: 'keep' | 'downgrade' | 'discard';
  /** Adjusted severity (if downgraded) */
  adjustedSeverity?: string;
  /** Enum normalization info */
  enumNormalization?: {
    severityOriginal: string;
    severityNormalized: string;
    categoryOriginal: string;
    categoryNormalized: string;
  };
}

/**
 * Verification result summary
 */
export interface VerificationResult {
  /** Findings that passed verification */
  verified: VerifiedFinding[];
  /** Findings that were discarded */
  discarded: VerifiedFinding[];
  /** Statistics */
  stats: {
    total: number;
    kept: number;
    downgraded: number;
    discarded: number;
    hallucinationRate: number;
  };
}

/**
 * Valid severity values
 */
const VALID_SEVERITIES = ['blocker', 'high', 'medium', 'low', 'info'] as const;
type Severity = typeof VALID_SEVERITIES[number];

/**
 * Severity aliases for normalization
 */
const SEVERITY_ALIASES: Record<string, Severity> = {
  critical: 'blocker',
  error: 'high',
  warning: 'medium',
  warn: 'medium',
  minor: 'low',
  trivial: 'info',
  suggestion: 'info',
  hint: 'info',
};

/**
 * Severity ordering for downgrade
 */
const SEVERITY_ORDER: Severity[] = ['blocker', 'high', 'medium', 'low', 'info'];

/**
 * Verification thresholds
 */
const THRESHOLDS = {
  KEEP: 0.7,
  DOWNGRADE: 0.4,
};

/**
 * Score weights for each check.
 * Total = 1.0 (ruleIdValid is bonus that can push score above base)
 */
const SCORE_WEIGHTS = {
  severityValid: 0.075,
  categoryValid: 0.075,
  fileExists: 0.2,
  lineInBounds: 0.15,
  lineInDiff: 0.2,
  snippetMatch: 0.2,
  contextValid: 0.1,
  ruleIdValid: 0.05, // Bonus for using valid project rule ID
};

/**
 * VerificationEngine - validates LLM findings against actual code
 */
export class VerificationEngine {
  private cwd: string;
  private changedFiles: Set<string>;
  private fetchedDiffs: Map<string, FileDiff>;
  private validCategories: string[];
  private categoryAliases: Record<string, string>;
  private validRuleIds: Set<string>;
  private fileContents: Map<string, string> = new Map();

  constructor(
    cwd: string,
    changedFiles: string[],
    fetchedDiffs: Map<string, FileDiff>,
    validCategories: string[],
    categoryAliases: Record<string, string> = {},
    validRuleIds: Set<string> = new Set()
  ) {
    this.cwd = cwd;
    this.changedFiles = new Set(changedFiles);
    this.fetchedDiffs = fetchedDiffs;
    this.validCategories = validCategories;
    this.categoryAliases = categoryAliases;
    this.validRuleIds = validRuleIds;
  }

  /**
   * Verify all findings from LLM
   */
  async verify(findings: RawFinding[]): Promise<VerificationResult> {
    const verified: VerifiedFinding[] = [];
    const discarded: VerifiedFinding[] = [];

    let keptCount = 0;
    let downgradedCount = 0;

    for (const finding of findings) {
      // eslint-disable-next-line no-await-in-loop -- Sequential verification maintains order
      const result = await this.verifyFinding(finding);

      if (result.action === 'discard') {
        discarded.push(result);
      } else {
        verified.push(result);
        if (result.action === 'keep') {
          keptCount++;
        } else {
          downgradedCount++;
        }
      }
    }

    const total = findings.length;
    const hallucinationRate = total > 0 ? discarded.length / total : 0;

    return {
      verified,
      discarded,
      stats: {
        total,
        kept: keptCount,
        downgraded: downgradedCount,
        discarded: discarded.length,
        hallucinationRate,
      },
    };
  }

  /**
   * Verify a single finding
   */
  private async verifyFinding(finding: RawFinding): Promise<VerifiedFinding> {
    // Normalize enums first
    const severityNorm = this.normalizeSeverity(finding.severity);
    const categoryNorm = this.normalizeCategory(finding.category);

    // Validate ruleId
    const ruleIdValid = this.validateRuleId(finding.ruleId);

    // Run all checks
    const checks: VerificationChecks = {
      severityValid: severityNorm.valid,
      categoryValid: categoryNorm.valid,
      fileExists: this.changedFiles.has(finding.file),
      lineInBounds: await this.checkLineInBounds(finding.file, finding.line),
      lineInDiff: this.checkLineInDiff(finding.file, finding.line),
      snippetMatch: await this.matchSnippet(finding.file, finding.line, finding.codeSnippet),
      contextValid: this.checkContext(finding),
      ruleIdValid,
    };

    // Calculate score
    const score = this.calculateScore(checks);

    // Determine action
    let action: 'keep' | 'downgrade' | 'discard';
    let adjustedSeverity: RawFindingSeverity | undefined;

    if (score >= THRESHOLDS.KEEP) {
      action = 'keep';
    } else if (score >= THRESHOLDS.DOWNGRADE) {
      action = 'downgrade';
      adjustedSeverity = this.downgradeSeverity(severityNorm.normalized);
    } else {
      action = 'discard';
    }

    // Update finding with normalized values
    const normalizedFinding: RawFinding = {
      ...finding,
      severity: adjustedSeverity ?? severityNorm.normalized,
      category: categoryNorm.normalized,
    };

    return {
      finding: normalizedFinding,
      score,
      checks,
      action,
      adjustedSeverity,
      enumNormalization: {
        severityOriginal: finding.severity,
        severityNormalized: severityNorm.normalized,
        categoryOriginal: finding.category,
        categoryNormalized: categoryNorm.normalized,
      },
    };
  }

  /**
   * Normalize severity value to RawFindingSeverity type.
   */
  private normalizeSeverity(value: string): { valid: boolean; normalized: RawFindingSeverity } {
    const lower = value.toLowerCase().trim();

    // Direct match
    if (VALID_SEVERITIES.includes(lower as Severity)) {
      return { valid: true, normalized: lower as RawFindingSeverity };
    }

    // Alias match
    if (SEVERITY_ALIASES[lower]) {
      return { valid: true, normalized: SEVERITY_ALIASES[lower] };
    }

    // Invalid - default to medium
    return { valid: false, normalized: 'medium' };
  }

  /**
   * Normalize category value
   */
  private normalizeCategory(value: string): { valid: boolean; normalized: string } {
    const lower = value.toLowerCase().trim();

    // No categories configured - accept anything as valid (skip category validation)
    if (this.validCategories.length === 0) {
      return { valid: true, normalized: value };
    }

    // Direct match
    if (this.validCategories.includes(lower)) {
      return { valid: true, normalized: lower };
    }

    // Alias match
    if (this.categoryAliases[lower]) {
      return { valid: true, normalized: this.categoryAliases[lower] };
    }

    // Invalid - use first category as default
    return { valid: false, normalized: this.validCategories[0] ?? 'other' };
  }

  /**
   * Check if line is within file bounds
   */
  private async checkLineInBounds(file: string, line: number): Promise<boolean> {
    if (line < 1) {
      return false;
    }

    try {
      const content = await this.getFileContent(file);
      if (!content) {
        return false;
      }

      const lineCount = content.split('\n').length;
      return line <= lineCount;
    } catch {
      return false;
    }
  }

  /**
   * Check if line is in the diff (actually changed)
   */
  private checkLineInDiff(file: string, line: number): boolean {
    const diff = this.fetchedDiffs.get(file);
    if (!diff) {
      return false;
    }

    return diff.changedLines.has(line);
  }

  /**
   * Match code snippet against actual file content
   */
  private async matchSnippet(
    file: string,
    targetLine: number,
    snippet?: string
  ): Promise<number> {
    // No snippet = neutral score
    if (!snippet) {
      return 0.5;
    }

    try {
      const content = await this.getFileContent(file);
      if (!content) {
        return 0;
      }

      const lines = content.split('\n');
      const windowSize = 5;

      const start = Math.max(0, targetLine - windowSize - 1);
      const end = Math.min(lines.length, targetLine + windowSize);
      const window = lines.slice(start, end).join('\n');

      // Strategy 1: Exact substring match
      if (window.includes(snippet)) {
        return 1.0;
      }

      // Strategy 2: Line-trimmed match
      const trimmedSnippet = snippet.split('\n').map(l => l.trim()).join('\n');
      const trimmedWindow = window.split('\n').map(l => l.trim()).join('\n');
      if (trimmedWindow.includes(trimmedSnippet)) {
        return 0.95;
      }

      // Strategy 3: Single-line normalized (for single-line snippets)
      if (!snippet.includes('\n')) {
        const normalizedSnippet = this.normalizeCodeLine(snippet);
        for (const line of lines.slice(start, end)) {
          if (this.normalizeCodeLine(line).includes(normalizedSnippet)) {
            return 0.9;
          }
        }
      }

      // Strategy 4: Token-based partial match
      const snippetTokens = this.extractIdentifiers(snippet);
      const windowTokens = new Set(this.extractIdentifiers(window));
      const matchedTokens = snippetTokens.filter(t => windowTokens.has(t));

      const tokenScore = matchedTokens.length / Math.max(snippetTokens.length, 1);
      return tokenScore * 0.8;
    } catch {
      return 0;
    }
  }

  /**
   * Normalize a single line of code (preserves strings)
   */
  private normalizeCodeLine(line: string): string {
    const strings: string[] = [];
    let normalized = line.replace(
      /(['"`])(?:(?!\1)[^\\]|\\.)*\1/g,
      (match) => {
        strings.push(match);
        return `__STR${strings.length - 1}__`;
      }
    );

    normalized = normalized.replace(/\s+/g, ' ').trim();

    strings.forEach((str, i) => {
      normalized = normalized.replace(`__STR${i}__`, str);
    });

    return normalized;
  }

  /**
   * Extract identifiers from code
   */
  private extractIdentifiers(code: string): string[] {
    const matches = code.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g) || [];

    const keywords = new Set([
      'const', 'let', 'var', 'function', 'class', 'if', 'else', 'for', 'while',
      'return', 'import', 'export', 'from', 'async', 'await', 'try', 'catch',
      'throw', 'new', 'this', 'true', 'false', 'null', 'undefined', 'typeof',
    ]);

    return matches.filter(m => !keywords.has(m) && m.length > 1);
  }

  /**
   * Validate ruleId - must be null or a valid rule ID from project rules
   */
  private validateRuleId(ruleId: string | null | undefined): boolean {
    // null is valid (ad-hoc finding)
    if (ruleId === null || ruleId === undefined) {
      return true;
    }

    // If no rules configured, accept any ruleId
    if (this.validRuleIds.size === 0) {
      return true;
    }

    // Check if ruleId matches a known rule
    return this.validRuleIds.has(ruleId);
  }

  /**
   * Check if finding makes sense for file context
   */
  private checkContext(finding: RawFinding): boolean {
    const fileLower = finding.file.toLowerCase();
    const messageLower = finding.message.toLowerCase();

    // SQL injection in non-DB file
    if (finding.category === 'security' &&
        messageLower.includes('sql') &&
        !fileLower.includes('db') &&
        !fileLower.includes('database') &&
        !fileLower.includes('query') &&
        !fileLower.includes('repository')) {
      return false;
    }

    // XSS in backend-only file
    if (messageLower.includes('xss') &&
        !fileLower.includes('component') &&
        !fileLower.includes('page') &&
        !fileLower.includes('.tsx') &&
        !fileLower.includes('.jsx')) {
      return false;
    }

    // Test file findings (usually less important)
    if (fileLower.includes('.test.') || fileLower.includes('.spec.')) {
      // Don't flag security issues in test files as context invalid
      // but they should be deprioritized elsewhere
    }

    return true;
  }

  /**
   * Calculate verification score
   */
  private calculateScore(checks: VerificationChecks): number {
    let score = 0;

    if (checks.severityValid) {
      score += SCORE_WEIGHTS.severityValid;
    }
    if (checks.categoryValid) {
      score += SCORE_WEIGHTS.categoryValid;
    }
    if (checks.fileExists) {
      score += SCORE_WEIGHTS.fileExists;
    }
    if (checks.lineInBounds) {
      score += SCORE_WEIGHTS.lineInBounds;
    }
    if (checks.lineInDiff) {
      score += SCORE_WEIGHTS.lineInDiff;
    }
    score += checks.snippetMatch * SCORE_WEIGHTS.snippetMatch;
    if (checks.contextValid) {
      score += SCORE_WEIGHTS.contextValid;
    }
    // Bonus for using valid project rule ID (increases confidence)
    if (checks.ruleIdValid) {
      score += SCORE_WEIGHTS.ruleIdValid;
    }

    return score;
  }

  /**
   * Downgrade severity by one level.
   * Returns the next lower severity or 'info' if already at lowest.
   */
  private downgradeSeverity(severity: RawFindingSeverity): RawFindingSeverity {
    const index = SEVERITY_ORDER.indexOf(severity);
    if (index === -1 || index >= SEVERITY_ORDER.length - 1) {
      return 'info';
    }
    return SEVERITY_ORDER[index + 1] ?? 'info';
  }

  /**
   * Get file content (with caching)
   */
  private async getFileContent(file: string): Promise<string | null> {
    if (this.fileContents.has(file)) {
      return this.fileContents.get(file)!;
    }

    try {
      const fullPath = path.join(this.cwd, file);
      const content = await readFile(fullPath, 'utf-8');
      this.fileContents.set(file, content);
      return content;
    } catch {
      return null;
    }
  }
}

/**
 * Create a VerificationEngine instance
 */
export function createVerificationEngine(
  cwd: string,
  changedFiles: string[],
  fetchedDiffs: Map<string, FileDiff>,
  validCategories: string[],
  categoryAliases?: Record<string, string>,
  validRuleIds?: Set<string>
): VerificationEngine {
  return new VerificationEngine(cwd, changedFiles, fetchedDiffs, validCategories, categoryAliases, validRuleIds);
}
