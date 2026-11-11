import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@kb-labs/agents/contracts';
import { useLLM } from '@kb-labs/sdk';
import { PlanGenerator } from '../../src/core/planning/plan-generator';

const chatWithToolsMock = vi.fn();

vi.mock('@kb-labs/sdk', () => ({
  useLLM: vi.fn(() => ({
    chatWithTools: chatWithToolsMock,
  })),
}));

const useLLMMock = vi.mocked(useLLM);

function makeUniversalPlanSections() {
  return {
    objective: {
      currentState: 'Current state identified',
      targetState: 'Target state identified',
      constraints: ['Keep behavior stable'],
    },
    evidence: [
      { id: 'e1', source: 'research', artifact: 'module map', confidence: 0.8 },
      { id: 'e2', source: 'research', artifact: 'dependency graph', confidence: 0.7 },
    ],
    decisions: [
      { id: 'd1', statement: 'Proceed with incremental changes', rationale: 'Minimize risk', evidenceIds: ['e1'], expectedImpact: 'Safer rollout' },
      { id: 'd2', statement: 'Validate after each phase', rationale: 'Catch regressions early', evidenceIds: ['e2'], expectedImpact: 'Higher confidence' },
    ],
    changeSets: [
      { id: 'cs1', decisionId: 'd1', capability: 'implementation', targets: ['src/a.ts'], operations: ['update module'], validation: 'pnpm test' },
      { id: 'cs2', decisionId: 'd2', capability: 'verification', targets: ['src'], operations: ['run checks'], validation: 'pnpm test' },
    ],
    verification: [
      { id: 'v1', check: 'tests pass', commandOrMethod: 'pnpm test', successSignal: 'exit code 0' },
    ],
    rollback: {
      trigger: 'Regression detected',
      steps: ['Revert touched files', 'Re-run tests'],
    },
  };
}

describe('PlanGenerator', () => {
  beforeEach(() => {
    chatWithToolsMock.mockReset();
    useLLMMock.mockClear();
  });

  it('uses tool-driven two-step flow: plan_research then plan_generate', async () => {
    chatWithToolsMock
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_research',
            input: {
              summary: 'Core files identified',
              findings: ['agent.ts coordinates mode handling'],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_generate',
            input: {
              ...makeUniversalPlanSections(),
              complexity: 'medium',
              estimatedDuration: '1 hour',
              phases: [
                {
                  id: 'phase-1',
                  name: 'Implement',
                  description: 'Implement core changes',
                  dependencies: [],
                  steps: [
                    {
                      id: 'step-1-1',
                      action: 'Edit file',
                      tool: 'fs:edit',
                      args: { path: 'src/a.ts' },
                      expectedOutcome: 'Change applied',
                    },
                  ],
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_generate',
            input: {
              markdown: [
                '# Plan: Update flow',
                '',
                '## Objective',
                '',
                'Support plan updates via unified run flow.',
                '',
                '## Phase 1: CLI wiring',
                '',
                '- Update run command arguments',
                '- Route feedback into plan update',
                '',
                '## Phase 2: API integration',
                '',
                '- Add/update REST handler via shared run interface',
                '- Align response contract',
                '',
                '## Verification',
                '',
                '- pnpm --filter @kb-labs/agents/cli test',
                '',
                '## Approval',
                '',
                '- Approve this plan for execution?',
              ].join('\n'),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_generate',
            input: {
              markdown: [
                '# Plan: Update flow',
                '',
                '## Objective',
                '',
                'Support plan updates via unified run flow.',
                '',
                '## Phase 1: CLI wiring',
                '',
                '- Update run command arguments',
                '- Route feedback into plan update',
                '',
                '## Phase 2: API integration',
                '',
                '- Add/update REST handler via shared run interface',
                '- Align response contract',
                '',
                '## Verification',
                '',
                '- pnpm --filter @kb-labs/agents/cli test',
                '',
                '## Approval',
                '',
                '- Approve this plan for execution?',
              ].join('\n'),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_generate',
            input: {
              markdown: [
                '# Plan: Update flow',
                '',
                '## Objective',
                '',
                'Support plan updates via unified run flow.',
                '',
                '## Phase 1: CLI wiring',
                '',
                '- Update run command arguments',
                '- Route feedback into plan update',
                '',
                '## Phase 2: API integration',
                '',
                '- Add/update REST handler via shared run interface',
                '- Align response contract',
                '',
                '## Verification',
                '',
                '- pnpm --filter @kb-labs/agents/cli test',
                '',
                '## Approval',
                '',
                '- Approve this plan for execution?',
              ].join('\n'),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_generate',
            input: {
              markdown: [
                '# Plan: Update flow',
                '',
                '## Objective',
                '',
                'Support plan updates via unified run flow.',
                '',
                '## Phase 1: CLI wiring',
                '',
                '- Update run command arguments',
                '- Route feedback into plan update',
                '',
                '## Phase 2: API integration',
                '',
                '- Add/update REST handler via shared run interface',
                '- Align response contract',
                '',
                '## Verification',
                '',
                '- pnpm --filter @kb-labs/agents/cli test',
                '',
                '## Approval',
                '',
                '- Approve this plan for execution?',
              ].join('\n'),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_generate',
            input: {
              markdown: [
                '# Plan: Update flow',
                '',
                '## Objective',
                '',
                'Support plan updates via unified run flow.',
                '',
                '## Phase 1: CLI wiring',
                '',
                '- Update run command arguments',
                '- Route feedback into plan update',
                '',
                '## Phase 2: API integration',
                '',
                '- Add/update REST handler via shared run interface',
                '- Align response contract',
                '',
                '## Verification',
                '',
                '- pnpm --filter @kb-labs/agents/cli test',
                '',
                '## Approval',
                '',
                '- Approve this plan for execution?',
              ].join('\n'),
            },
          },
        ],
      });

    const generator = new PlanGenerator();
    const plan = await generator.generate({
      task: 'Add plan flow',
      sessionId: 'session-1',
      mode: 'plan',
      complexity: 'medium',
    });

    expect(chatWithToolsMock).toHaveBeenCalledTimes(2);
    expect(plan.status).toBe('draft');
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0]?.steps[0]?.tool).toBe('fs:edit');
  });

  it('updates existing plan through plan_update tool and keeps plan identity', async () => {
    chatWithToolsMock.mockResolvedValueOnce({
      toolCalls: [
        {
          name: 'plan_update',
          input: {
            complexity: 'complex',
            estimatedDuration: '2 hours',
            revisionSummary: 'Expanded verification phase',
            phases: [
              {
                id: 'phase-1',
                name: 'Revised phase',
                description: 'Revised description',
                dependencies: [],
                steps: [
                  {
                    id: 'step-1',
                    action: 'Run tests',
                    tool: 'shell:exec',
                    args: { command: 'pnpm test' },
                    expectedOutcome: 'Tests pass',
                  },
                ],
              },
            ],
          },
        },
      ],
    });

    const generator = new PlanGenerator();
    const existingPlan = {
      id: 'plan-123',
      sessionId: 'session-1',
      task: 'Add plan flow',
      mode: 'plan' as const,
      phases: [],
      estimatedDuration: '30m',
      complexity: 'medium' as const,
      createdAt: '2026-02-21T00:00:00.000Z',
      updatedAt: '2026-02-21T00:00:00.000Z',
      status: 'approved' as const,
    };

    const updated = await generator.update({
      plan: existingPlan,
      feedback: 'Add stronger verification steps',
    });

    expect(chatWithToolsMock).toHaveBeenCalledTimes(1);
    expect(updated.id).toBe(existingPlan.id);
    expect(updated.createdAt).toBe(existingPlan.createdAt);
    expect(updated.status).toBe('draft');
    expect(updated.phases[0]?.steps[0]?.tool).toBe('shell:exec');
  });

  it('re-generates refactoring plans when first draft is audit-heavy', async () => {
    chatWithToolsMock
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_research',
            input: {
              summary: 'Research complete',
              findings: ['module located'],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_generate_refactor',
            input: {
              objective: {
                currentState: 'Monolithic structure',
                targetState: 'Modular structure',
                constraints: ['No behavior changes'],
              },
              evidence: [
                { id: 'e1', source: 'research', artifact: 'module hotspot', confidence: 0.8 },
                { id: 'e2', source: 'research', artifact: 'coupling points', confidence: 0.7 },
              ],
              complexity: 'medium',
              estimatedDuration: '1h',
              phases: [
                {
                  id: 'phase-1',
                  name: 'Discovery',
                  description: 'Audit module',
                  steps: [
                    { id: 's1', action: 'Analyze architecture', tool: 'fs:read', expectedOutcome: 'Understood module' },
                    { id: 's2', action: 'Audit tests', tool: 'fs:search', expectedOutcome: 'Listed tests' },
                  ],
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_generate_refactor',
            input: {
              objective: {
                currentState: 'Monolithic structure',
                targetState: 'Modular structure',
                constraints: ['No behavior changes'],
              },
              evidence: [
                { id: 'e1', source: 'research', artifact: 'module hotspot', confidence: 0.8 },
                { id: 'e2', source: 'research', artifact: 'coupling points', confidence: 0.7 },
              ],
              complexity: 'medium',
              estimatedDuration: '2h',
              refactorDecisions: [
                {
                  id: 'd1',
                  target: 'plan-document-service.ts',
                  action: 'extract',
                  rationale: 'Isolate toc rendering',
                  expectedImpact: 'Lower coupling',
                  validation: 'pnpm test',
                },
                {
                  id: 'd2',
                  target: 'toc-builder.ts',
                  action: 'split',
                  rationale: 'Move responsibilities out',
                  expectedImpact: 'Better maintainability',
                  validation: 'pnpm test',
                },
                {
                  id: 'd3',
                  target: 'plan-mode-handler.ts',
                  action: 'decouple',
                  rationale: 'Reduce direct dependencies',
                  expectedImpact: 'Improved testability',
                  validation: 'pnpm test',
                },
              ],
              changeSets: [
                {
                  id: 'cs1',
                  decisionId: 'd1',
                  targetFiles: ['plan-document-service.ts'],
                  operations: ['extract TocBuilder'],
                  validation: 'pnpm test',
                },
                {
                  id: 'cs2',
                  decisionId: 'd2',
                  targetFiles: ['toc-builder.ts'],
                  operations: ['create module'],
                  validation: 'pnpm test',
                },
              ],
              phases: [
                {
                  id: 'phase-1',
                  name: 'Refactor structure',
                  description: 'Split module by responsibilities',
                  steps: [
                    { id: 's1', action: 'Edit plan-document-service.ts to extract TocBuilder', tool: 'fs:edit', expectedOutcome: 'TocBuilder extracted' },
                    { id: 's2', action: 'Write new toc-builder.ts module', tool: 'fs:write', expectedOutcome: 'New module created' },
                    { id: 's3', action: 'Run tests', tool: 'shell:exec', expectedOutcome: 'Tests pass' },
                  ],
                },
              ],
            },
          },
        ],
      });

    const generator = new PlanGenerator();
    const plan = await generator.generate({
      task: 'Create refactoring plan for plan-document-service',
      sessionId: 'session-refactor',
      mode: 'plan',
      complexity: 'medium',
    });

    expect(chatWithToolsMock).toHaveBeenCalledTimes(3);
    expect(plan.phases[0]?.steps.length).toBeGreaterThan(0);
    expect(plan.phases.some((phase) => phase.steps.some((step) => typeof step.tool === 'string' && step.tool.length > 0))).toBe(true);
  });

  it('keeps one-shot draft when quality issues are non-critical', async () => {
    chatWithToolsMock
      .mockResolvedValueOnce({
        toolCalls: [
          { name: 'plan_research', input: { summary: 'Research complete', findings: ['module located'] } },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_generate',
            input: {
              ...makeUniversalPlanSections(),
              complexity: 'medium',
              estimatedDuration: '1h',
              phases: [
                {
                  id: 'phase-1',
                  name: 'Audit',
                  description: 'Audit module',
                  steps: [
                    { id: 's1', action: 'Audit structure', tool: 'fs:read', expectedOutcome: 'Structure understood' },
                    { id: 's2', action: 'Audit tests', tool: 'fs:search', expectedOutcome: 'Tests listed' },
                    { id: 's3', action: 'Edit module to extract TOC renderer', tool: 'fs:edit', expectedOutcome: 'Core refactor started' },
                  ],
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_generate',
            input: {
              complexity: 'medium',
              estimatedDuration: '1h',
              phases: [],
            },
          },
        ],
      });

    const generator = new PlanGenerator();
    const plan = await generator.generate({
      task: 'Create implementation plan for plan-document-service',
      sessionId: 'session-refactor-fallback',
      mode: 'plan',
      complexity: 'medium',
    });

    expect(chatWithToolsMock).toHaveBeenCalledTimes(2);
    expect(plan.phases.length).toBe(1);
    expect(plan.phases[0]?.steps.some((s) => s.tool === 'fs:edit' || s.tool === 'fs_patch')).toBe(true);
  });

  it('supports markdown-first plan tool output and derives executable phases from markdown headings', async () => {
    chatWithToolsMock
      .mockResolvedValueOnce({
        toolCalls: [
          { name: 'plan_research', input: { summary: 'Research complete', findings: ['module located'] } },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_generate',
            input: {
              markdown: [
                '# Plan: Refactor planner',
                '',
                '## Task',
                '',
                'Refactor planning module for readability.',
                '',
                '## Steps',
                '',
                '### Split responsibilities',
                '',
                '- Extract TOC logic into helper',
                '- Keep behavior unchanged with tests',
                '',
                '### Validate',
                '',
                '- Run planning test suite',
                '',
                '## Risks',
                '',
                '- Hidden coupling between parser and renderer',
                '',
                '## Verification',
                '',
                '- pnpm --filter @kb-labs/agents/core test -- src/planning/__tests__/plan-generator.test.ts',
                '',
                '## Approval',
                '',
                '- Approve this plan for execution?',
              ].join('\n'),
              complexity: 'medium',
              estimatedDuration: '1h',
            },
          },
        ],
      });

    const generator = new PlanGenerator();
    const plan = await generator.generate({
      task: 'Create plan for improving planning module readability',
      sessionId: 'session-markdown-first',
      mode: 'plan',
      complexity: 'medium',
    });

    expect(typeof plan.markdown).toBe('string');
    expect(plan.markdown).toContain('## Steps');
    expect(plan.phases.length).toBeGreaterThan(0);
    expect(plan.phases[0]?.steps.length).toBeGreaterThan(0);
  });

  it('builds fallback executable phases when markdown output is placeholder-only', async () => {
    chatWithToolsMock
      .mockResolvedValueOnce({
        toolCalls: [
          { name: 'plan_research', input: { summary: 'Research complete', findings: ['planning module located'] } },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_generate',
            input: {
              markdown: 'placeholder',
              complexity: 'medium',
              estimatedDuration: '30m',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_generate',
            input: {
              markdown: 'placeholder',
              complexity: 'medium',
              estimatedDuration: '30m',
            },
          },
        ],
      });

    const generator = new PlanGenerator();
    const plan = await generator.generate({
      task: 'Improve planning module structure',
      sessionId: 'session-fallback',
      mode: 'plan',
      complexity: 'medium',
    });

    expect(plan.phases.length).toBeGreaterThan(0);
    expect(plan.phases[0]?.steps.length).toBeGreaterThan(0);
    expect(plan.markdown).not.toBe('placeholder');
    expect(plan.markdown).toContain('## Steps');
    expect(plan.markdown).toContain('## Verification');
  });

  it('derives phases from markdown that uses ## Phase headings', async () => {
    chatWithToolsMock
      .mockResolvedValueOnce({
        toolCalls: [
          { name: 'plan_research', input: { summary: 'Research complete', findings: ['module located'] } },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_generate',
            input: {
              markdown: [
                '# Plan: Update flow',
                '',
                '## Objective',
                '',
                'Support plan updates via unified run flow.',
                '',
                '## Phase 1: CLI wiring',
                '',
                '- Update run command arguments',
                '- Route feedback into plan update',
                '',
                '## Phase 2: API integration',
                '',
                '- Add/update REST handler via shared run interface',
                '- Align response contract',
                '',
                '## Risks',
                '',
                '- Regression in existing run path',
                '',
                '## Verification',
                '',
                '- pnpm --filter @kb-labs/agents/cli test',
                '',
                '## Approval',
                '',
                '- Approve this plan for execution?',
              ].join('\n'),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_generate',
            input: {
              markdown: [
                '# Plan: Update flow',
                '',
                '## Objective',
                '',
                'Support plan updates via unified run flow.',
                '',
                '## Phase 1: CLI wiring',
                '',
                '- Update run command arguments',
                '- Route feedback into plan update',
                '',
                '## Phase 2: API integration',
                '',
                '- Add/update REST handler via shared run interface',
                '- Align response contract',
                '',
                '## Verification',
                '',
                '- pnpm --filter @kb-labs/agents/cli test',
                '',
                '## Approval',
                '',
                '- Approve this plan for execution?',
              ].join('\n'),
            },
          },
        ],
      });

    const generator = new PlanGenerator();
    const plan = await generator.generate({
      task: 'Plan update flow through shared run interface',
      sessionId: 'session-markdown-phase2',
      mode: 'plan',
      complexity: 'medium',
    });

    expect(plan.phases.length).toBeGreaterThanOrEqual(2);
    expect(plan.phases[0]?.name.toLowerCase()).toContain('phase 1');
    expect(plan.phases[0]?.steps.length).toBeGreaterThan(0);
  });

  it('synthesizes executable phases from refactor changeSets when phases are missing', async () => {
    chatWithToolsMock
      .mockResolvedValueOnce({
        toolCalls: [
          { name: 'plan_research', input: { summary: 'Research complete', findings: ['targets found'] } },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'plan_generate_refactor',
            input: {
              objective: {
                currentState: 'Tight coupling',
                targetState: 'Separated boundaries',
                constraints: ['No API break'],
              },
              evidence: [
                { id: 'e1', source: 'research', artifact: 'boundary leak', confidence: 0.8 },
                { id: 'e2', source: 'research', artifact: 'dependency chain', confidence: 0.7 },
              ],
              complexity: 'medium',
              estimatedDuration: '2h',
              refactorDecisions: [
                {
                  id: 'd1',
                  target: 'a.ts',
                  action: 'extract',
                  rationale: 'Split responsibilities',
                  expectedImpact: 'Cleaner module',
                  validation: 'pnpm test',
                },
                {
                  id: 'd2',
                  target: 'b.ts',
                  action: 'decouple',
                  rationale: 'Reduce coupling',
                  expectedImpact: 'Easier testing',
                  validation: 'pnpm test',
                },
                {
                  id: 'd3',
                  target: 'c.ts',
                  action: 'rename',
                  rationale: 'Improve readability',
                  expectedImpact: 'Clearer API',
                  validation: 'pnpm test',
                },
              ],
              changeSets: [
                {
                  id: 'cs1',
                  decisionId: 'd1',
                  targetFiles: ['src/a.ts'],
                  operations: ['extract helper'],
                  validation: 'pnpm test',
                },
                {
                  id: 'cs2',
                  decisionId: 'd2',
                  targetFiles: ['src/b.ts'],
                  operations: ['introduce interface'],
                  validation: 'pnpm test',
                },
              ],
              phases: [],
            },
          },
        ],
      });

    const generator = new PlanGenerator();
    const plan = await generator.generate({
      task: 'Create refactoring plan for module boundaries',
      sessionId: 'session-refactor-synth',
      mode: 'plan',
      complexity: 'medium',
    });

    expect(plan.phases.length).toBeGreaterThan(0);
    expect(plan.phases[0]?.steps.some((s) => s.tool === 'fs:edit' || s.tool === 'fs_patch')).toBe(true);
    expect(plan.phases[0]?.steps.some((s) => s.tool === 'shell:exec' || s.tool === 'shell_exec')).toBe(true);
  });

  it('emits detailed tracing events for research, generation, and update', async () => {
    const events: AgentEvent[] = [];

    chatWithToolsMock
      .mockResolvedValueOnce({
        usage: { promptTokens: 10, completionTokens: 20 },
        toolCalls: [
          {
            name: 'plan_research',
            input: {
              summary: 'Research complete',
              findings: ['Found target files'],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        usage: { promptTokens: 20, completionTokens: 30 },
        toolCalls: [
          {
            name: 'plan_generate',
            input: {
              ...makeUniversalPlanSections(),
              complexity: 'medium',
              estimatedDuration: '45m',
              phases: [
                {
                  id: 'phase-1',
                  name: 'Implement',
                  description: 'Implement',
                  steps: [
                    {
                      id: 'step-1',
                      action: 'Edit files',
                      tool: 'fs:edit',
                      expectedOutcome: 'Updated files',
                    },
                  ],
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        usage: { promptTokens: 5, completionTokens: 8 },
        toolCalls: [
          {
            name: 'plan_update',
            input: {
              revisionSummary: 'Adjusted phase',
              phases: [
                {
                  id: 'phase-1',
                  name: 'Adjusted',
                  description: 'Adjusted',
                  steps: [
                    {
                      id: 'step-1',
                      action: 'Run tests',
                      tool: 'shell:exec',
                      expectedOutcome: 'Tests pass',
                    },
                  ],
                },
              ],
            },
          },
        ],
      });

    const generator = new PlanGenerator();
    const generated = await generator.generate({
      task: 'Trace me',
      sessionId: 'session-trace',
      mode: 'plan',
      onEvent: (event) => events.push(event),
    });

    await generator.update({
      plan: generated,
      feedback: 'Refine steps',
      onEvent: (event) => events.push(event),
    });

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('status:change');
    expect(eventTypes).toContain('progress:update');
    expect(eventTypes).toContain('llm:start');
    expect(eventTypes).toContain('llm:end');
    expect(eventTypes).toContain('tool:start');
    expect(eventTypes).toContain('tool:end');

    const toolStarts = events
      .filter((e): e is Extract<AgentEvent, { type: 'tool:start' }> => e.type === 'tool:start')
      .map((e) => e.data.toolName);
    expect(toolStarts).toContain('plan_research');
    expect(toolStarts).toContain('plan_generate');
    expect(toolStarts).toContain('plan_update');
  });

  it('propagates requested tier to llm initialization and llm:start events', async () => {
    const events: AgentEvent[] = [];

    chatWithToolsMock
      .mockResolvedValueOnce({
        usage: { promptTokens: 8, completionTokens: 14 },
        toolCalls: [
          {
            name: 'plan_research',
            input: {
              summary: 'Research complete',
              findings: ['Found module boundaries'],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        usage: { promptTokens: 10, completionTokens: 12 },
        toolCalls: [
          {
            name: 'plan_generate_refactor',
            input: {
              complexity: 'medium',
              estimatedDuration: '50m',
              markdown: '# Draft\n## Task\n- A\n## Steps\n- B',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        usage: { promptTokens: 12, completionTokens: 15 },
        toolCalls: [
          {
            name: 'plan_generate_refactor',
            input: {
              complexity: 'medium',
              estimatedDuration: '1h',
              markdown: '# Refactor Plan\n## Table of Contents\n- [Task](#task)\n- [Steps](#steps)\n- [Risks](#risks)\n- [Verification](#verification)\n- [Approval](#approval)\n\n## Task\n- Current state (A): monolith\n- Target state (B): modular\n- Scope boundaries: planning module\n\n## Steps\n### Phase 1: Split services\n- Goal: isolate responsibilities\n- Actions: extract toc builder and validator\n- Expected outcome: lower coupling\n\n## Risks\n- Risk: behavior drift\n- Mitigation: characterization tests\n\n## Verification\n- Command/check: pnpm test\n- Success signal: all tests pass\n\n## Approval\n- Ready for approval: yes\n- Open questions (if any): none\n',
            },
          },
        ],
      });

    const generator = new PlanGenerator();
    await generator.generate({
      task: 'Refactor planning module',
      sessionId: 'session-tier',
      mode: 'plan',
      tier: 'small',
      onEvent: (event) => events.push(event),
    });

    expect(useLLMMock).toHaveBeenCalledWith({ tier: 'small' });
    const llmStarts = events.filter((e): e is Extract<AgentEvent, { type: 'llm:start' }> => e.type === 'llm:start');
    expect(llmStarts.length).toBeGreaterThanOrEqual(3);
    for (const event of llmStarts) {
      expect(event.data.tier).toBe('small');
    }
  });
});
