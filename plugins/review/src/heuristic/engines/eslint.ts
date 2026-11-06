/**
 * @module @kb-labs/review/heuristic/engines/eslint
 * ESLint engine - runs ESLint CLI and parses JSON output.
 */

import type { ReviewFinding, FindingSeverity } from '../../contracts/index.js';
import type { LinterEngine } from './types.js';

/**
 * Map ESLint severity (1=warn, 2=error) to ReviewFinding severity.
 */
function mapSeverity(eslintSeverity: number): FindingSeverity {
  if (eslintSeverity === 2) {
    return 'high';
  }
  if (eslintSeverity === 1) {
    return 'medium';
  }
  return 'info';
}

/**
 * ESLint JSON output format (per file).
 */
interface ESLintFileResult {
  filePath: string;
  messages: Array<{
    ruleId: string | null;
    severity: number;
    message: string;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
    fix?: {
      range: [number, number];
      text: string;
    };
  }>;
  errorCount: number;
  warningCount: number;
}

/**
 * ESLint engine definition.
 */
export const eslintEngine: LinterEngine = {
  id: 'eslint',
  name: 'ESLint',
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
  configFiles: [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
    '.eslintrc',
  ],

  buildCommand(files: string[], _cwd: string): string[] {
    return ['npx', 'eslint', '--format', 'json', ...files];
  },

  parseOutput(json: string, _cwd: string): ReviewFinding[] {
    const results: ESLintFileResult[] = JSON.parse(json);
    const findings: ReviewFinding[] = [];

    for (const result of results) {
      for (const msg of result.messages) {
        findings.push({
          id: `eslint:${result.filePath}:${msg.ruleId ?? 'unknown'}:${msg.line}:${msg.column}`,
          ruleId: msg.ruleId ?? 'eslint/unknown',
          type: 'code-quality',
          severity: mapSeverity(msg.severity),
          confidence: 'certain',
          file: result.filePath,
          line: msg.line ?? 1,
          column: msg.column ?? 1,
          endLine: msg.endLine ?? msg.line ?? 1,
          message: msg.message,
          engine: 'eslint',
          source: 'heuristic',
          scope: msg.fix ? 'local' : 'global',
          automated: !!msg.fix,
        });
      }
    }

    return findings;
  },

  async isAvailable(): Promise<boolean> {
    try {
      const { execSync } = await import('child_process');
      execSync('npx eslint --version', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  },
};
