/**
 * @module @kb-labs/review/heuristic/engines/ruff
 * Ruff engine - runs Ruff CLI and parses JSON output.
 *
 * Ruff is an extremely fast Python linter written in Rust.
 */

import type { ReviewFinding, FindingSeverity } from '../../contracts/index.js';
import type { LinterEngine } from './types.js';

/**
 * Ruff JSON output format (per diagnostic).
 */
interface RuffDiagnostic {
  code: string;
  message: string;
  filename: string;
  location: {
    row: number;
    column: number;
  };
  end_location: {
    row: number;
    column: number;
  };
  fix?: {
    message: string;
    edits: Array<{
      content: string;
      location: { row: number; column: number };
      end_location: { row: number; column: number };
    }>;
  };
  noqa_row?: number;
}

/**
 * Map Ruff code prefix to severity.
 * E = Error, W = Warning, F = Fatal, etc.
 */
function mapSeverity(code: string): FindingSeverity {
  const prefix = code.charAt(0).toUpperCase();

  switch (prefix) {
    case 'E': // Error
    case 'F': // Pyflakes
      return 'high';
    case 'W': // Warning
    case 'C': // Convention
      return 'medium';
    case 'I': // Isort
    case 'D': // Docstring
      return 'low';
    default:
      return 'medium';
  }
}

/**
 * Ruff engine definition.
 */
export const ruffEngine: LinterEngine = {
  id: 'ruff',
  name: 'Ruff',
  extensions: ['.py', '.pyi'],
  configFiles: [
    'pyproject.toml',
    'ruff.toml',
    '.ruff.toml',
  ],

  buildCommand(files: string[], _cwd: string): string[] {
    return ['ruff', 'check', '--output-format', 'json', ...files];
  },

  parseOutput(json: string, _cwd: string): ReviewFinding[] {
    const diagnostics: RuffDiagnostic[] = JSON.parse(json);
    const findings: ReviewFinding[] = [];

    for (const d of diagnostics) {
      findings.push({
        id: `ruff:${d.filename}:${d.code}:${d.location.row}:${d.location.column}`,
        ruleId: d.code,
        type: 'code-quality',
        severity: mapSeverity(d.code),
        confidence: 'certain',
        file: d.filename,
        line: d.location.row,
        column: d.location.column,
        endLine: d.end_location.row,
        message: d.message,
        engine: 'ruff',
        source: 'heuristic',
        scope: d.fix ? 'local' : 'global',
        automated: !!d.fix,
      });
    }

    return findings;
  },

  async isAvailable(): Promise<boolean> {
    try {
      const { execSync } = await import('child_process');
      execSync('ruff --version', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  },
};
