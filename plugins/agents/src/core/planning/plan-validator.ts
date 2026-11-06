/**
 * Plan Output Validator — deterministic rubric-based quality gate for generated plans.
 *
 * Checks specificity, actionability, completeness, and verification without LLM calls.
 * Returns a composite score (0–1) and pass/fail verdict.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = 'error' | 'warning' | 'info';

export interface ValidatorIssue {
  dimension: 'specificity' | 'actionability' | 'completeness' | 'verification';
  severity: Severity;
  message: string;
}

export interface RubricScore {
  raw: number;       // 0.0–1.0 before weighting
  weighted: number;  // raw * weight
  details: string;
}

export interface PlanValidationResult {
  passed: boolean;
  score: number;
  rubric: {
    specificity: RubricScore;
    actionability: RubricScore;
    completeness: RubricScore;
    verification: RubricScore;
  };
  issues: ValidatorIssue[];
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

const W_SPECIFICITY   = 0.30;
const W_ACTIONABILITY = 0.35;
const W_COMPLETENESS  = 0.15;
const W_VERIFICATION  = 0.20;

const PASS_THRESHOLD  = 0.35;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect file-path-like tokens: `foo/bar.ts`, `src/index.js`, etc. */
const FILE_PATH_RE = /[\w@.-]+\/[\w@.-]+\.[\w]{1,5}/g;

/** Detect backtick-wrapped shell commands or bare pnpm/npm/npx/git invocations. */
const COMMAND_RE = /(?:`[^`]+`)|(?:(?:pnpm|npm|npx|git|yarn|bun)\s+\S+)/g;

/** Extract bullet items (- or 1.) and table data rows from markdown. */
function extractBullets(text: string): string[] {
  const bullets = (text.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/gm) || [])
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim())
    .filter(Boolean);
  // Also treat non-separator table rows as actionable items
  const tableRows = (text.match(/^\|(?![-:]+\|).+\|$/gm) || [])
    .map((line) => line.replace(/^\||\|$/g, '').trim())
    .filter(Boolean);
  return [...bullets, ...tableRows];
}

/** Clamp to [0, 1]. */
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Get text under a heading (## or ###) until the next heading of same or higher level. */
function getSectionBody(text: string, headingRe: RegExp): string {
  const lines = text.split('\n');
  let capturing = false;
  let captureLevel = 0;
  const result: string[] = [];
  for (const line of lines) {
    if (headingRe.test(line)) {
      capturing = true;
      const match = /^(#{1,6})\s+/.exec(line);
      captureLevel = match ? match[1]!.length : 2;
      continue;
    }
    if (capturing) {
      const headingMatch = /^(#{1,6})\s+/.exec(line);
      if (headingMatch && headingMatch[1]!.length <= captureLevel) {break;}
      result.push(line);
    }
  }
  return result.join('\n');
}

function countNonEmptyLines(section: string): number {
  return section.split('\n').filter((l) => l.trim().length > 0).length;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export class PlanValidator {
  /**
   * Validate a markdown plan and return rubric-based scoring.
   */
  validate(markdown: string): PlanValidationResult {
    const text = (markdown || '').replace(/\r\n/g, '\n').trim();
    const issues: ValidatorIssue[] = [];

    // ----- Specificity (0.30) -----
    const specificity = this.scoreSpecificity(text, issues);

    // ----- Actionability (0.35) -----
    const actionability = this.scoreActionability(text, issues);

    // ----- Completeness (0.15) -----
    const completeness = this.scoreCompleteness(text, issues);

    // ----- Verification (0.20) -----
    const verification = this.scoreVerification(text, issues);

    const score = clamp01(
      specificity.weighted +
      actionability.weighted +
      completeness.weighted +
      verification.weighted
    );

    const hasErrors = issues.some((i) => i.severity === 'error');
    const passed = score >= PASS_THRESHOLD && !hasErrors;

    return {
      passed,
      score,
      rubric: { specificity, actionability, completeness, verification },
      issues,
    };
  }

  // -----------------------------------------------------------------------
  // Specificity — real file paths in the plan
  // -----------------------------------------------------------------------

  private scoreSpecificity(text: string, issues: ValidatorIssue[]): RubricScore {
    const matches = text.match(FILE_PATH_RE) || [];
    const unique = new Set(matches.map((m) => m.toLowerCase()));
    const count = unique.size;

    let raw: number;
    if (count >= 5) {
      raw = 1.0;
    } else if (count >= 2) {
      raw = 0.5 + (count - 2) * 0.167; // 2→0.5, 5→1.0
    } else if (count === 1) {
      raw = 0.25;
    } else {
      raw = 0;
    }
    raw = clamp01(raw);

    if (count === 0) {
      issues.push({
        dimension: 'specificity',
        severity: 'warning',
        message: 'Plan contains no file paths — consider adding specific file references.',
      });
    } else if (count < 2) {
      issues.push({
        dimension: 'specificity',
        severity: 'warning',
        message: `Only ${count} unique file path found. Plans should reference specific files.`,
      });
    }

    return { raw, weighted: raw * W_SPECIFICITY, details: `${count} unique file path(s)` };
  }

  // -----------------------------------------------------------------------
  // Actionability — steps with concrete actions (file path / command / tool)
  // -----------------------------------------------------------------------

  private scoreActionability(text: string, issues: ValidatorIssue[]): RubricScore {
    const bullets = extractBullets(text);
    if (bullets.length === 0) {
      issues.push({
        dimension: 'actionability',
        severity: 'error',
        message: 'Plan has no bullet/numbered steps — nothing to execute.',
      });
      return { raw: 0, weighted: 0, details: '0 steps' };
    }

    let actionable = 0;
    for (const bullet of bullets) {
      const hasPath = FILE_PATH_RE.test(bullet);
      FILE_PATH_RE.lastIndex = 0;
      const hasCmd = COMMAND_RE.test(bullet);
      COMMAND_RE.lastIndex = 0;
      if (hasPath || hasCmd) {actionable++;}
    }

    const ratio = actionable / bullets.length;
    const raw = clamp01(ratio);

    if (actionable === 0) {
      issues.push({
        dimension: 'actionability',
        severity: 'error',
        message: 'No step contains a file path or command — plan is purely descriptive.',
      });
    } else if (ratio < 0.3) {
      issues.push({
        dimension: 'actionability',
        severity: 'warning',
        message: `Only ${actionable}/${bullets.length} steps reference files or commands.`,
      });
    }

    return {
      raw,
      weighted: raw * W_ACTIONABILITY,
      details: `${actionable}/${bullets.length} actionable steps`,
    };
  }

  // -----------------------------------------------------------------------
  // Completeness — required sections with substance
  // -----------------------------------------------------------------------

  private scoreCompleteness(text: string, issues: ValidatorIssue[]): RubricScore {
    const sections: Array<{ name: string; re: RegExp; required: boolean }> = [
      { name: 'Task', re: /^#{2,3}\s+(task|objective)\b/im, required: true },
      { name: 'Steps', re: /^#{2,3}\s+(steps?|execution plan|phases?|steps\/phases)\b/im, required: true },
      { name: 'Risks', re: /^#{2,3}\s+(risks?|risks\s*&\s*mitigations?)\b/im, required: false },
      { name: 'Verification', re: /^#{2,3}\s+(verification|verification checklist)\b/im, required: true },
    ];

    let found = 0;
    let withSubstance = 0;

    for (const sec of sections) {
      if (sec.re.test(text)) {
        found++;
        const body = getSectionBody(text, sec.re);
        if (countNonEmptyLines(body) >= 2) {
          withSubstance++;
        } else {
          issues.push({
            dimension: 'completeness',
            severity: 'warning',
            message: `Section "${sec.name}" exists but has less than 2 lines of content.`,
          });
        }
      } else if (sec.required) {
        issues.push({
          dimension: 'completeness',
          severity: 'warning',
          message: `Missing required section: ${sec.name}.`,
        });
      }
    }

    const raw = clamp01(withSubstance / sections.length);

    if (found === 0) {
      issues.push({
        dimension: 'completeness',
        severity: 'error',
        message: 'Plan has no recognized sections (## Task, ## Steps, etc.).',
      });
    }

    return {
      raw,
      weighted: raw * W_COMPLETENESS,
      details: `${withSubstance}/${sections.length} sections with substance`,
    };
  }

  // -----------------------------------------------------------------------
  // Verification — runnable commands in verification section
  // -----------------------------------------------------------------------

  private scoreVerification(text: string, issues: ValidatorIssue[]): RubricScore {
    const verifBody = getSectionBody(text, /^#{2,3}\s+(verification|verification checklist)\b/im);

    if (!verifBody.trim()) {
      // Fall back to entire document for commands
      const cmds = text.match(COMMAND_RE) || [];
      if (cmds.length > 0) {
        issues.push({
          dimension: 'verification',
          severity: 'warning',
          message: 'Commands found outside Verification section.',
        });
        return { raw: 0.3, weighted: 0.3 * W_VERIFICATION, details: `${cmds.length} commands (outside section)` };
      }

      issues.push({
        dimension: 'verification',
        severity: 'error',
        message: 'No verification commands found anywhere in the plan.',
      });
      return { raw: 0, weighted: 0, details: '0 commands' };
    }

    const cmds = verifBody.match(COMMAND_RE) || [];
    let raw: number;
    if (cmds.length >= 3) {
      raw = 1.0;
    } else if (cmds.length >= 1) {
      raw = 0.4 + cmds.length * 0.2;
    } else {
      raw = 0;
      issues.push({
        dimension: 'verification',
        severity: 'warning',
        message: 'Verification section exists but contains no runnable commands.',
      });
    }
    raw = clamp01(raw);

    return {
      raw,
      weighted: raw * W_VERIFICATION,
      details: `${cmds.length} verification command(s)`,
    };
  }
}
