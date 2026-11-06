import { describe, it, expect } from 'vitest';
import { SpecValidator } from '../../src/core/planning/spec-validator';
import type { TaskPlan, TaskSpec } from '@kb-labs/agents/contracts';

function makePlan(phaseCount = 2, stepsPerPhase = 2): TaskPlan {
  const phases = Array.from({ length: phaseCount }, (_, i) => ({
    id: `phase-${i + 1}`,
    name: `Phase ${i + 1}`,
    description: `Phase ${i + 1} description`,
    dependencies: [],
    status: 'pending' as const,
    steps: Array.from({ length: stepsPerPhase }, (__, j) => ({
      id: `step-${i + 1}-${j + 1}`,
      action: `Do something in phase ${i + 1} step ${j + 1}`,
      expectedOutcome: 'Done',
      status: 'pending' as const,
    })),
  }));

  return {
    id: 'plan-test',
    sessionId: 'session-test',
    task: 'Test task',
    mode: 'plan',
    phases,
    complexity: 'medium',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'approved',
  };
}

function makeSpec(plan: TaskPlan, opts?: { emptyBefore?: boolean; noChanges?: boolean; missingPhases?: boolean }): TaskSpec {
  const sections = (opts?.missingPhases ? plan.phases.slice(0, 1) : plan.phases).map((phase) => ({
    planPhaseId: phase.id,
    title: phase.name,
    description: phase.description,
    changes: opts?.noChanges ? [] : [{
      file: 'packages/agent-core/src/agent.ts',
      lineRange: '3510-3514',
      before: opts?.emptyBefore ? '' : 'private log(message: string): void {\n  if (this.config.verbose) {\n    console.log(message);\n  }\n}',
      after: 'private log(message: string): void {\n  this.logger?.debug(message);\n  if (this.config.verbose) {\n    console.log(message);\n  }\n}',
      explanation: 'Wire useLogger into log()',
    }],
  }));

  return {
    id: 'spec-test',
    planId: plan.id,
    sessionId: 'session-test',
    task: plan.task,
    sections,
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('SpecValidator', () => {
  const validator = new SpecValidator();

  describe('validate()', () => {
    it('should pass on a well-formed spec with full coverage', () => {
      const plan = makePlan(2, 1);
      const spec = makeSpec(plan);
      const result = validator.validate(spec, plan);

      expect(result.passed).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0.6);
      expect(result.rubric.coverage.raw).toBeGreaterThan(0);
      expect(result.rubric.precision.raw).toBeGreaterThan(0);
      expect(result.rubric.files.raw).toBeGreaterThan(0);
    });

    it('should fail on spec with no sections', () => {
      const plan = makePlan();
      const spec: TaskSpec = {
        id: 'spec-empty',
        planId: plan.id,
        sessionId: 'session-test',
        task: plan.task,
        sections: [],
        status: 'draft',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = validator.validate(spec, plan);
      expect(result.passed).toBe(false);
      expect(result.issues.some((i) => i.dimension === 'coverage' && i.severity === 'error')).toBe(true);
    });

    it('should fail on spec with no code changes', () => {
      const plan = makePlan();
      const spec = makeSpec(plan, { noChanges: true });

      const result = validator.validate(spec, plan);
      expect(result.passed).toBe(false);
      expect(result.issues.some((i) => i.dimension === 'precision' && i.severity === 'error')).toBe(true);
    });

    it('should warn on partial phase coverage', () => {
      const plan = makePlan(4, 1);
      const spec = makeSpec(plan, { missingPhases: true }); // Only covers phase-1

      const result = validator.validate(spec, plan);
      expect(result.rubric.coverage.raw).toBeLessThan(1);
      expect(result.issues.some((i) => i.dimension === 'coverage')).toBe(true);
    });

    it('should reduce precision score when before is empty', () => {
      const plan = makePlan(1, 1);
      const spec = makeSpec(plan, { emptyBefore: true });

      const result = validator.validate(spec, plan);
      expect(result.rubric.precision.raw).toBeLessThan(1);
    });

    it('should score files based on valid paths', () => {
      const plan = makePlan(1, 1);
      const spec = makeSpec(plan);
      // Good path: packages/agent-core/src/agent.ts
      const result = validator.validate(spec, plan);
      expect(result.rubric.files.raw).toBe(1);
    });
  });

  describe('validateMarkdown()', () => {
    it('should fail on empty markdown', () => {
      const plan = makePlan();
      const result = validator.validateMarkdown('', plan);
      expect(result.passed).toBe(false);
      expect(result.score).toBe(0);
    });

    it('should pass on well-formed spec markdown', () => {
      const plan = makePlan(1, 1);
      const markdown = `# Spec: Test

### [phase-1:step-1] Wire useLogger

**File:** \`packages/agent-core/src/agent.ts\`
**Lines:** 3510-3514

**Before (current):**
\`\`\`ts
private log(message: string): void {
  if (this.config.verbose) {
    console.log(message);
  }
}
\`\`\`

**After:**
\`\`\`ts
private log(message: string): void {
  this.logger?.debug(message);
  if (this.config.verbose) {
    console.log(message);
  }
}
\`\`\`

**Why:** Wires useLogger into log()`;

      const result = validator.validateMarkdown(markdown, plan);
      expect(result.passed).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0.6);
    });

    it('should fail on markdown with no code blocks', () => {
      const plan = makePlan();
      const result = validator.validateMarkdown('Just some text without any diffs', plan);
      expect(result.passed).toBe(false);
    });

    it('should fail when step coverage is too low even with diff blocks', () => {
      const plan = makePlan(3, 2); // 6 steps
      const markdown = `# Spec: Partial

### [phase-1:step-1] Change A

**File:** \`packages/agent-core/src/agent.ts\`
**Lines:** 10-20

**Before (current):**
\`\`\`ts
const a = 1;
\`\`\`

**After:**
\`\`\`ts
const a = 2;
\`\`\`

**Why:** Update behavior`;

      const result = validator.validateMarkdown(markdown, plan);
      expect(result.passed).toBe(false);
      expect(result.metrics.stepCoverage).toBeLessThan(0.5);
      expect(result.issues.some((i) => i.dimension === 'coverage' && i.severity === 'error')).toBe(true);
    });

    it('should expose uncovered step metrics', () => {
      const plan = makePlan(2, 2); // 4 steps
      const markdown = `# Spec: Mostly complete

### [phase-1:step-1] A
**File:** \`packages/agent-core/src/agent.ts\`
**Lines:** 1-2
**Before (current):**
\`\`\`ts
a
\`\`\`
**After:**
\`\`\`ts
b
\`\`\`

### [phase-1:step-2] B
**File:** \`packages/agent-core/src/agent.ts\`
**Lines:** 3-4
**Before (current):**
\`\`\`ts
c
\`\`\`
**After:**
\`\`\`ts
d
\`\`\`

### [phase-2:step-1] C
**File:** \`packages/agent-core/src/agent.ts\`
**Lines:** 5-6
**Before (current):**
\`\`\`ts
e
\`\`\`
**After:**
\`\`\`ts
f
\`\`\``;

      const result = validator.validateMarkdown(markdown, plan);
      expect(result.metrics.planStepCount).toBe(4);
      expect(result.metrics.coveredStepRefs).toBe(3);
      expect(result.metrics.uncoveredStepCount).toBe(1);
    });
  });
});
