import { PlanValidator, type PlanValidationResult } from '../planning/plan-validator.js';

export interface PlanOutputValidation {
  passed: boolean;
  summary: string;
  result: PlanValidationResult;
}

export class PlanOutputValidator {
  private readonly validator = new PlanValidator();

  validate(markdown: string): PlanOutputValidation {
    const result = this.validator.validate(markdown);
    return {
      passed: result.passed,
      summary: this.buildSummary(result),
      result,
    };
  }

  private buildSummary(result: PlanValidationResult): string {
    const topIssues = result.issues
      .filter((issue) => issue.severity !== 'info')
      .slice(0, 3)
      .map((issue) => `${issue.dimension}: ${issue.message}`);

    return topIssues.length > 0
      ? topIssues.join(' | ')
      : `Plan validation passed with score ${result.score.toFixed(2)}.`;
  }
}
