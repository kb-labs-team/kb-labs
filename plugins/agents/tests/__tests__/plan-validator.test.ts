import { describe, it, expect } from 'vitest';
import { PlanValidator } from '../../src/core/planning/plan-validator';

describe('PlanValidator', () => {
  const validator = new PlanValidator();

  describe('validate()', () => {
    it('should fail on empty markdown', () => {
      const result = validator.validate('');
      expect(result.passed).toBe(false);
      expect(result.score).toBe(0);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('should fail on generic template without file paths', () => {
      const generic = `# Plan: Do something

## Task
- Current state: things are broken
- Target state: things are fixed

## Steps
### Phase 1: Fix things
1. Update the configuration file
2. Ensure tests pass
3. Deploy changes

## Risks
- Risk: something might break
- Mitigation: be careful

## Verification
- Run tests
- Check logs

## Approval
- Ready: yes`;

      const result = validator.validate(generic);
      // Generic plan has no real file paths or commands — should score low
      expect(result.rubric.specificity.raw).toBe(0);
      expect(result.issues.some((i) => i.dimension === 'specificity')).toBe(true);
    });

    it('should pass on a well-crafted plan with file paths and commands', () => {
      const good = `# Plan: Add validation to agent config

## Table of Contents
- [Task](#task)
- [Steps](#steps)
- [Risks](#risks)
- [Verification](#verification)

## Task
- Current state (A): AgentConfig in packages/agent-contracts/src/types.ts has no validation
- Target state (B): Add Zod schema validation for AgentConfig

## Steps
### Phase 1: Schema Definition
1. Create packages/agent-core/src/config/schema.ts — define Zod schema for AgentConfig
2. Edit packages/agent-contracts/src/types.ts:258 — add \`validate\` method to AgentConfig
3. Edit packages/agent-core/src/agent.ts:42 — call config.validate() in constructor

### Phase 2: Integration
4. Edit packages/agent-core/src/modes/execute-mode-handler.ts — validate config before execution
5. Add packages/agent-core/src/config/__tests__/schema.test.ts — unit tests for schema

## Risks
- Risk: breaking existing callers that pass invalid configs
- Mitigation: make validation warnings-only in v1, strict in v2

## Verification
- \`pnpm --filter @kb-labs/agents/core test\`
- \`pnpm --filter @kb-labs/agents/contracts run build\`
- \`pnpm --filter @kb-labs/agents/core run build\`

## Approval
- Ready for approval: yes`;

      const result = validator.validate(good);
      expect(result.passed).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0.5);
      expect(result.rubric.specificity.raw).toBeGreaterThan(0);
      expect(result.rubric.actionability.raw).toBeGreaterThan(0);
      expect(result.rubric.verification.raw).toBeGreaterThan(0);
    });

    it('should score specificity based on unique file paths', () => {
      const plan = `# Plan

## Task
- Fix the bug

## Steps
1. Edit src/foo.ts — fix the issue
2. Edit src/bar.ts — update import

## Verification
- \`pnpm test\``;

      const result = validator.validate(plan);
      // 2 unique file paths → should score ~0.5 for specificity
      expect(result.rubric.specificity.raw).toBeGreaterThanOrEqual(0.5);
    });

    it('should score actionability based on steps with file paths or commands', () => {
      const plan = `# Plan

## Task
- Refactor module

## Steps
1. Edit src/module.ts — extract helper function
2. Ensure code quality
3. Run \`pnpm lint\` to verify
4. Check everything works

## Verification
- \`pnpm test\``;

      const result = validator.validate(plan);
      // 2/4 steps are actionable (file path or command)
      expect(result.rubric.actionability.raw).toBe(0.5);
    });

    it('should score completeness based on section substance', () => {
      const planWithAllSections = `# Plan

## Task
- Current: broken
- Target: fixed

## Steps
1. Fix src/index.ts

## Risks
- Could break things
- Mitigate by testing

## Verification
- \`pnpm test\`
- Check output`;

      const result = validator.validate(planWithAllSections);
      expect(result.rubric.completeness.raw).toBeGreaterThan(0);
    });

    it('should detect missing verification commands', () => {
      const noVerif = `# Plan

## Task
- Do something

## Steps
1. Edit src/foo.ts

## Risks
- Low risk`;

      const result = validator.validate(noVerif);
      expect(result.issues.some(
        (i) => i.dimension === 'verification' && i.severity === 'error'
      )).toBe(true);
    });

    it('should find commands outside verification section as fallback', () => {
      const plan = `# Plan

## Task
- Fix things

## Steps
1. Edit src/foo.ts — fix bug
2. Run \`pnpm --filter @kb-labs/core test\` to verify`;

      const result = validator.validate(plan);
      // Commands found but outside Verification section → partial score
      expect(result.rubric.verification.raw).toBeGreaterThan(0);
      expect(result.rubric.verification.raw).toBeLessThan(1);
    });

    it('should return error issues for plans with no steps', () => {
      const noSteps = `# Plan

## Task
- Something needs to happen

Some free text without any bullets or numbered items.`;

      const result = validator.validate(noSteps);
      expect(result.passed).toBe(false);
      expect(result.issues.some(
        (i) => i.dimension === 'actionability' && i.severity === 'error'
      )).toBe(true);
    });
  });
});
